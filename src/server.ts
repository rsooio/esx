import { start } from "node:repl";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { format, inspect } from "node:util";
import { Runtime } from "./runtime.ts";

if (!process.env.DEBUG) {
  console.debug = () => {};
}

type Request = {
  id?: string | number;
  op: string;
  [key: string]: unknown;
};

type Pending = {
  resolve(value: any): void;
  reject(error: any): void;
};

let pending: Pending | null = null;
let currentId: string | null = null;

const writeStdout = process.stdout.write.bind(process.stdout);

function send(message: Record<string, unknown>) {
  writeStdout(JSON.stringify(message) + "\n");
}

function output(text: string, isError = false) {
  const message: Record<string, unknown> = { op: isError ? "err" : "out" };
  if (currentId !== null) message.id = currentId;
  message[isError ? "err" : "out"] = text;
  send(message);
}

function errorInfo(error: any) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    stack: error?.stack ?? "",
    ...(error?.loc ? { line: error.loc.line, column: error.loc.column } : {}),
  };
}

const input = new PassThrough();
const outputStream = new PassThrough();
outputStream.on("data", (chunk) => output(String(chunk), true));

const repl = start({
  input,
  output: outputStream,
  terminal: false,
  prompt: "",
  writer: () => "",
  useGlobal: false,
  // Supported REPL error hook.  Returning "ignore" prevents node:repl from
  // printing an "Uncaught" line and lets us fail the pending request.
  handleError(error: any) {
    const current = pending;
    pending = null;
    if (current) current.reject(error);
    else output(format(error) + "\n", true);
    return "ignore";
  },
} as any);

const originalEval = repl.eval.bind(repl);

repl.context.console = {
  log: (...args: any[]) => output(format(...args) + "\n"),
  info: (...args: any[]) => output(format(...args) + "\n"),
  warn: (...args: any[]) => output(format(...args) + "\n", true),
  error: (...args: any[]) => output(format(...args) + "\n", true),
  debug: (...args: any[]) => output(format(...args) + "\n"),
  dir: (value: any, options?: any) =>
    output(inspect(value, { colors: false, ...options }) + "\n"),
  table: (value: any) => output(inspect(value, { colors: false }) + "\n"),
  trace: (...args: any[]) => output("Trace: " + format(...args) + "\n", true),
  assert: (condition: any, ...args: any[]) => {
    if (!condition) output("Assertion failed: " + format(...args) + "\n", true);
  },
} as any;

const stream = (isError: boolean) => ({
  isTTY: false,
  write(chunk: any) {
    output(String(chunk), isError);
    return true;
  },
});

repl.context.process = new Proxy(process, {
  get(target, property) {
    if (property === "stdout") return stream(false);
    if (property === "stderr") return stream(true);
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
}) as any;

const runtime = new Runtime({
  context: repl.context,
  eval(code, file) {
    return new Promise((resolve, reject) => {
      pending = { resolve, reject };
      originalEval(code, repl.context, file, (error, result) => {
        const current = pending;
        if (!current) return;
        pending = null;
        error ? current.reject(error) : current.resolve(result);
      });
    });
  },
});

// `node:repl` reports thrown values through `_handleError` instead of the
// eval callback.  Newer Node versions expose the `handleError` option above;
// keep a fallback for versions without it.
if (!(repl as any)._userErrorHandler) {
  (repl as any)._handleError = (error: any) => {
    const current = pending;
    pending = null;
    if (current) current.reject(error);
    else output(format(error) + "\n", true);
  };
}

let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function print(value: any) {
  return inspect(value, {
    colors: false,
    depth: 4,
    maxArrayLength: 100,
    breakLength: 100,
  });
}

async function evaluate(request: Request) {
  const id = request.id;
  const ns = typeof request.ns === "string" && request.ns ? request.ns : "user";
  currentId = id === undefined ? null : String(id);
  try {
    const value = await runtime.eval(String(request.code ?? ""), ns);
    send({ id, status: ["done"], value: print(value), ns });
  } catch (error) {
    send({ id, status: ["eval-error", "done"], ex: errorInfo(error), ns });
  } finally {
    currentId = null;
  }
}

async function loadFile(request: Request) {
  const id = request.id;
  const ns = typeof request.ns === "string" && request.ns ? request.ns : "user";
  currentId = id === undefined ? null : String(id);
  try {
    const path = String(request.path ?? "");
    const url = pathToFileURL(path).href;
    await runtime.load(ns, url);
    send({ id, status: ["done"], ns });
  } catch (error) {
    send({ id, status: ["eval-error", "done"], ex: errorInfo(error), ns });
  } finally {
    currentId = null;
  }
}

function handle(request: Request) {
  switch (request.op) {
    case "ping":
      send({ id: request.id, status: ["done"], value: "pong" });
      break;
    case "eval":
      void enqueue(() => evaluate(request));
      break;
    case "load-file":
      void enqueue(() => loadFile(request));
      break;
    case "ns-list": {
      const namespaces = new Set(["user", ...runtime.list()]);
      send({ id: request.id, status: ["done"], namespaces: [...namespaces].sort() });
      break;
    }
    case "ns-vars": {
      const ns = typeof request.ns === "string" && request.ns ? request.ns : "user";
      send({ id: request.id, status: ["done"], vars: Object.keys(runtime.vals(ns)).sort() });
      break;
    }
    case "switch-ns": {
      const ns = typeof request.ns === "string" && request.ns ? request.ns : "user";
      const specifier = String(request.specifier ?? "");
      send({ id: request.id, status: ["done"], ns: runtime.resolve(ns, specifier) });
      break;
    }
    case "quit":
      send({ id: request.id, status: ["done"] });
      process.exit(0);
      break;
    default:
      send({
        id: request.id,
        status: ["error", "done"],
        ex: { name: "Error", message: `Unknown operation: ${request.op}`, stack: "" },
      });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line) as Request);
    } catch (error) {
      send({
        id: null,
        status: ["error", "done"],
        ex: { name: "Error", message: `Invalid request: ${error}`, stack: "" },
      });
    }
  }
});

send({
  op: "hello",
  version: 1,
  pid: process.pid,
  node: process.version,
  cwd: process.cwd(),
});
