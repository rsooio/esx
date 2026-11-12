import { pathToFileURL } from "node:url";
import { format } from "node:util";
import { Runtime } from "./runtime.ts";
import { Evaluator } from "./evaluator.ts";

if (!process.env.DEBUG) {
  console.debug = () => {};
}

type Request = {
  id?: string | number;
  op: string;
  [key: string]: unknown;
};

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
    ...(error?.loc
      ? { line: error.loc.line, column: error.loc.column }
      : {}),
  };
}

const evaluator = await Evaluator.create({
  cwd: process.cwd(),
  onOutput: output,
});

const runtime = new Runtime({
  context: evaluator.context,
  eval: (code, file) => evaluator.evaluate(code, file),
});

let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function evaluate(request: Request) {
  const id = request.id;
  const ns = typeof request.ns === "string" && request.ns ? request.ns : "user";
  currentId = id === undefined ? null : String(id);
  try {
    const value = await runtime.eval(String(request.code ?? ""), ns);
    send({ id, status: ["done"], value, ns });
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

// Async user code can reject outside the eval Promise; surface it in the
// transcript instead of letting the process die.
process.on("unhandledRejection", (reason) => {
  output(`unhandledRejection: ${format(reason)}\n`, true);
});
process.on("uncaughtException", (error) => {
  output(`uncaughtException: ${format(error)}\n`, true);
});

send({
  op: "hello",
  version: 1,
  pid: process.pid,
  node: process.version,
  cwd: process.cwd(),
});
