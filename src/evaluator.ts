import { Session } from "node:inspector";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { format, inspect } from "node:util";
import vm from "node:vm";

export type EvaluatorOptions = {
  cwd: string;
  onOutput(text: string, isError?: boolean): void;
};

type RemoteObject = {
  type?: string;
  subtype?: string;
  className?: string;
  description?: string;
  value?: unknown;
  unserializableValue?: string;
  objectId?: string;
};

const OBJECT_GROUP = "esx";

/**
 * Server-side evaluator.
 *
 * Uses the inspector's `Runtime.evaluate` with `replMode: true` (the same
 * mechanism as current Node main's REPL evaluator): top-level await,
 * completion values and global lexical bindings are handled by V8, without
 * an async IIFE or `processTopLevelAwait`.
 */
export class Evaluator {
  context!: vm.Context;

  private readonly options: EvaluatorOptions;
  private readonly session: Session;
  private readonly sandbox: Record<string, any>;
  private contextId = 0;

  static async create(options: EvaluatorOptions) {
    const evaluator = new Evaluator(options);
    await evaluator.initialize();
    return evaluator;
  }

  private constructor(options: EvaluatorOptions) {
    this.options = options;
    this.session = new Session();
    this.sandbox = this.createSandbox();
  }

  private async initialize() {
    this.session.connect();
    await this.post("Runtime.enable");

    const created = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out creating the inspector context")),
        5000,
      );
      const onCreated = ({
        params,
      }: {
        params: { context: { id: number; auxData?: { isDefault?: boolean } } };
      }) => {
        if (params.context.auxData?.isDefault) return;
        clearTimeout(timer);
        (this.session as any).removeListener(
          "Runtime.executionContextCreated",
          onCreated,
        );
        resolve(params.context.id);
      };
      (this.session as any).on("Runtime.executionContextCreated", onCreated);
    });

    // `vm.createContext` triggers `Runtime.executionContextCreated`.
    this.context = vm.createContext(this.sandbox);
    this.contextId = await created;

    // `global` is a REPL convenience, not a vm intrinsic.
    this.context.global = this.context;
  }

  private createSandbox() {
    const sandbox: Record<string, any> = {};
    const skip = new Set([
      "globalThis",
      "global",
      "console",
      "process",
      "localStorage",
      "sessionStorage",
    ]);

    for (const key of Object.getOwnPropertyNames(globalThis)) {
      if (skip.has(key)) continue;
      try {
        sandbox[key] = (globalThis as any)[key];
      } catch {
        // Some globals are lazy getters that may throw in this context.
      }
    }

    sandbox.console = this.createConsole();
    sandbox.process = this.createProcess();
    sandbox.__esxInspect = (value: any) =>
      inspect(value, {
        colors: false,
        depth: 4,
        maxArrayLength: 100,
        breakLength: 100,
      });
    sandbox.global = sandbox;
    sandbox.module = { exports: {} };
    sandbox.exports = sandbox.module.exports;

    return sandbox;
  }

  private createConsole() {
    const emit = (text: string, isError = false) => {
      this.options.onOutput(text, isError);
    };

    return {
      log: (...args: any[]) => emit(format(...args) + "\n"),
      info: (...args: any[]) => emit(format(...args) + "\n"),
      debug: (...args: any[]) => emit(format(...args) + "\n"),
      warn: (...args: any[]) => emit(format(...args) + "\n", true),
      error: (...args: any[]) => emit(format(...args) + "\n", true),
      dir: (value: any, options?: any) =>
        emit(inspect(value, { colors: false, ...options }) + "\n"),
      table: (value: any) => emit(inspect(value, { colors: false }) + "\n"),
      trace: (...args: any[]) => emit("Trace: " + format(...args) + "\n", true),
      assert: (condition: any, ...args: any[]) => {
        if (!condition) emit("Assertion failed: " + format(...args) + "\n", true);
      },
    };
  }

  private createProcess() {
    const emit = (text: string, isError: boolean) => {
      this.options.onOutput(text, isError);
    };
    const stream = (isError: boolean) => ({
      isTTY: false,
      write(chunk: any) {
        emit(String(chunk), isError);
        return true;
      },
    });

    return new Proxy(process, {
      get(target, property) {
        if (property === "stdout") return stream(false);
        if (property === "stderr") return stream(true);
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  async evaluate(code: string, filename = "user") {
    const dir = filename.startsWith("file://")
      ? dirname(fileURLToPath(filename))
      : this.options.cwd;

    this.context.require = createRequire(pathToFileURL(join(dir, "__esx__.js")));
    this.context.__dirname = dir;
    this.context.__filename = join(dir, "__esx__.js");
    this.context.module = { exports: {} };
    this.context.exports = this.context.module.exports;

    try {
      let response = await this.post("Runtime.evaluate", {
        expression: code,
        objectGroup: OBJECT_GROUP,
        silent: false,
        returnByValue: false,
        generatePreview: false,
        awaitPromise: false,
        replMode: true,
        throwOnSideEffect: false,
        contextId: this.contextId,
      });

      if (response.result?.subtype === "promise") {
        response = await this.post("Runtime.awaitPromise", {
          promiseObjectId: response.result.objectId,
          returnByValue: false,
          generatePreview: false,
        });
      }

      if (response.exceptionDetails) {
        throw this.errorFrom(response.exceptionDetails);
      }

      return await this.display(response.result);
    } finally {
      await this.post("Runtime.releaseObjectGroup", {
        objectGroup: OBJECT_GROUP,
      }).catch(() => {});
    }
  }

  private async display(remote: RemoteObject | undefined): Promise<string> {
    if (!remote) return "undefined";

    if (remote.objectId) {
      try {
        const response = await this.post("Runtime.callFunctionOn", {
          objectId: remote.objectId,
          functionDeclaration: "function() { return __esxInspect(this); }",
          returnByValue: true,
          objectGroup: OBJECT_GROUP,
        });
        if (!response.exceptionDetails && response.result?.value !== undefined) {
          return String(response.result.value);
        }
      } catch {
        // Fall back to the remote description below.
      }
      return remote.description ?? remote.className ?? "<object>";
    }

    if (remote.type === "undefined") return "undefined";
    if (remote.subtype === "null") return "null";
    if (remote.type === "symbol") return remote.description ?? "Symbol()";
    if (remote.unserializableValue !== undefined) {
      return remote.unserializableValue;
    }
    if ("value" in remote) return inspect(remote.value);

    return remote.description ?? remote.type ?? "undefined";
  }

  private errorFrom(details: any): Error {
    const remote = details.exception ?? details.result;
    const description =
      remote?.description ?? details.text ?? "Evaluation error";
    const className = remote?.className ?? "Error";
    const firstLine = String(description).split("\n")[0];
    const prefix = `${className}: `;
    const message = firstLine.startsWith(prefix)
      ? firstLine.slice(prefix.length)
      : firstLine;

    const error = new Error(message);
    error.name = className;
    error.stack = String(description);
    return error;
  }

  private post(method: string, params: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      this.session.post(method, params, (error, result) => {
        if (error) reject(error);
        else resolve(result);
      });
    });
  }

  dispose() {
    try {
      this.session.post("Runtime.disable");
    } catch {
      // The session may already be disconnected.
    }
    this.session.disconnect();
  }
}
