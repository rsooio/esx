import { format } from "node:util";
import { Realm } from "./realm.ts";

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

const realm = await Realm.start({
  cwd: process.cwd(),
  onOutput(text, isError = false) {
    output(text, isError);
  },
  onExit(code, signal) {
    output(`user realm exited (${code ?? signal ?? "unknown"})\n`, true);
  },
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
    const value = await realm.eval(String(request.code ?? ""), ns);
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
    await realm.load(path, ns);
    send({ id, status: ["done"], ns });
  } catch (error) {
    send({ id, status: ["eval-error", "done"], ex: errorInfo(error), ns });
  } finally {
    currentId = null;
  }
}

async function listNamespaces(request: Request) {
  try {
    const namespaces = new Set(["user", ...(await realm.listNamespaces())]);
    send({
      id: request.id,
      status: ["done"],
      namespaces: [...namespaces].sort(),
    });
  } catch (error) {
    send({
      id: request.id,
      status: ["eval-error", "done"],
      ex: errorInfo(error),
    });
  }
}

async function listVariables(request: Request) {
  try {
    const ns = typeof request.ns === "string" && request.ns ? request.ns : "user";
    const vars = await realm.listVariables(ns);
    send({ id: request.id, status: ["done"], vars: vars.sort() });
  } catch (error) {
    send({
      id: request.id,
      status: ["eval-error", "done"],
      ex: errorInfo(error),
    });
  }
}

async function switchNamespace(request: Request) {
  try {
    const ns = typeof request.ns === "string" && request.ns ? request.ns : "user";
    const specifier = String(request.specifier ?? "");
    const resolved = await realm.resolveNamespace(ns, specifier);
    send({ id: request.id, status: ["done"], ns: resolved });
  } catch (error) {
    send({
      id: request.id,
      status: ["eval-error", "done"],
      ex: errorInfo(error),
    });
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
    case "ns-list":
      void enqueue(() => listNamespaces(request));
      break;
    case "ns-vars":
      void enqueue(() => listVariables(request));
      break;
    case "switch-ns":
      void enqueue(() => switchNamespace(request));
      break;
    case "quit":
      send({ id: request.id, status: ["done"] });
      void realm.stop().then(
        () => process.exit(0),
        () => process.exit(0),
      );
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
  realm: realm.info.pid,
  node: process.version,
  cwd: process.cwd(),
});
