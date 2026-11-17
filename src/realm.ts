import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const childEntry = fileURLToPath(new URL("./realm-child.ts", import.meta.url));

export type RealmOptions = {
  cwd: string;
  onOutput(text: string, isError?: boolean): void;
  onExit?(code: number | null, signal: NodeJS.Signals | null): void;
};

type RealmInfo = {
  pid: number;
  node: string;
  cwd: string;
};

type Pending = {
  resolve(value: any): void;
  reject(error: Error): void;
};

export class Realm {
  private readonly options: RealmOptions;
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, Pending>();
  private readonly ready: Promise<RealmInfo>;
  private readonly exited: Promise<void>;
  private resolveReady!: (info: RealmInfo) => void;
  private rejectReady!: (error: Error) => void;
  private resolveExit!: () => void;
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private stopping = false;
  info!: RealmInfo;

  static async start(options: RealmOptions) {
    const realm = new Realm(options);
    await realm.initialize();
    return realm;
  }

  private constructor(options: RealmOptions) {
    this.options = options;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });

    this.child = fork(childEntry, [], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.child.stdout!.setEncoding("utf8");
    this.child.stderr!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => {
      options.onOutput(chunk, false);
    });
    this.child.stderr!.on("data", (chunk: string) => {
      options.onOutput(chunk, true);
    });
    this.child.on("message", (message) => this.onMessage(message));
    this.child.on("exit", (code, signal) => this.onExit(code, signal));
    this.child.on("error", (error) => this.onError(error));
  }

  private async initialize() {
    const timer = setTimeout(() => {
      this.rejectReady(new Error("Timed out starting the user realm"));
    }, 10000);
    try {
      this.info = await this.ready;
    } catch (error) {
      this.child.kill();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  eval(code: string, ns = "user") {
    return this.request<string>("eval", { ns, code });
  }

  load(path: string, ns = "user") {
    return this.request<void>("load", { ns, path });
  }

  listNamespaces() {
    return this.request<string[]>("ns-list");
  }

  listVariables(ns = "user") {
    return this.request<string[]>("ns-vars", { ns });
  }

  resolveNamespace(ns: string, specifier: string) {
    return this.request<string>("resolve", { ns, specifier });
  }

  async stop() {
    if (this.stopped) return;
    this.stopping = true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill();
        resolve();
      }, 1000);
      this.exited.then(() => {
        clearTimeout(timer);
        resolve();
      });
      try {
        this.child.send({ type: "quit", id: this.nextId++ }, () => {});
      } catch {
        this.child.kill();
        clearTimeout(timer);
        resolve();
      }
    });
  }

  kill() {
    this.child.kill();
  }

  private request<T>(type: string, params: Record<string, unknown> = {}) {
    const run = this.queue.then(
      () =>
        new Promise<T>((resolve, reject) => {
          if (this.stopped) {
            reject(new Error("The user realm is not running"));
            return;
          }
          const id = this.nextId++;
          this.pending.set(id, { resolve, reject });
          try {
            this.child.send({ type, id, ...params }, (error) => {
              if (!error) return;
              this.pending.delete(id);
              reject(error);
            });
          } catch (error) {
            this.pending.delete(id);
            reject(error as Error);
          }
        }),
      () =>
        new Promise<T>((_, reject) => {
          reject(new Error("The user realm is not running"));
        }),
    );
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private onMessage(message: any) {
    if (message?.type === "ready") {
      this.resolveReady({
        pid: message.pid,
        node: message.node,
        cwd: message.cwd,
      });
      return;
    }
    const pending = this.pending.get(message?.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.type === "result") {
      pending.resolve(message.value);
    } else if (message.type === "error") {
      const error = new Error(message.error?.message ?? "Realm error");
      error.name = message.error?.name ?? "Error";
      error.stack = message.error?.stack ?? "";
      pending.reject(error);
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null) {
    this.stopped = true;
    this.resolveExit();
    this.rejectReady(
      new Error(`The user realm exited with ${code ?? signal ?? "unknown"}`),
    );
    for (const pending of this.pending.values()) {
      pending.reject(
        new Error(`The user realm exited with ${code ?? signal ?? "unknown"}`),
      );
    }
    this.pending.clear();
    if (!this.stopping) this.options.onExit?.(code, signal);
  }

  private onError(error: Error) {
    this.rejectReady(error);
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
