import { Session } from "node:inspector";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspect } from "node:util";

export type EvaluatorOptions = {
  cwd: string;
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

function inspectValue(value: any) {
  return inspect(value, {
    colors: false,
    depth: 4,
    maxArrayLength: 100,
    breakLength: 100,
  });
}

/**
 * Server-side evaluator.
 *
 * Uses the inspector's `Runtime.evaluate` with `replMode: true` (the same
 * mechanism as current Node main's REPL evaluator): top-level await,
 * completion values and global lexical bindings are handled by V8, without
 * an async IIFE or `processTopLevelAwait`.
 */
export class Evaluator {
  context!: Record<string, any>;

  private readonly options: EvaluatorOptions;
  private readonly session: Session;

  static async create(options: EvaluatorOptions) {
    const evaluator = new Evaluator(options);
    await evaluator.initialize();
    return evaluator;
  }

  private constructor(options: EvaluatorOptions) {
    this.options = options;
    this.session = new Session();
  }

  private async initialize() {
    this.session.connect();
    await this.post("Runtime.enable");
    this.context = globalThis as Record<string, any>;
    this.context.__esxInspect = inspectValue;
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
