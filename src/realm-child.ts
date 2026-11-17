import { pathToFileURL } from "node:url";
import { format } from "node:util";
import { Evaluator } from "./evaluator.ts";
import { Runtime } from "./runtime.ts";

if (!process.env.DEBUG) {
  console.debug = () => {};
}

process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && !process.env.DEBUG) return;
  process.stderr.write(`${warning.name}: ${warning.message}\n`);
});

const send = process.send!.bind(process);
const realExit = process.exit.bind(process);
process.exit = ((code?: number) => {
  throw new Error(`process.exit(${code ?? 0}) is not available in the REPL`);
}) as typeof process.exit;

const evaluator = await Evaluator.create({ cwd: process.cwd() });
const runtime = new Runtime({
  context: evaluator.context,
  eval: (code, file) => evaluator.evaluate(code, file),
});

function errorInfo(error: any) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    stack: error?.stack ?? "",
  };
}

async function handle(message: any) {
  if (!message || typeof message.type !== "string") return;
  const id = message.id;
  const ns = typeof message.ns === "string" && message.ns ? message.ns : "user";
  try {
    switch (message.type) {
      case "eval": {
        const value = await runtime.eval(String(message.code ?? ""), ns);
        send({ type: "result", id, value, ns });
        break;
      }
      case "load": {
        const path = String(message.path ?? "");
        const url = path.startsWith("file://") ? path : pathToFileURL(path).href;
        await runtime.load(ns, url);
        send({ type: "result", id, ns });
        break;
      }
      case "ns-list": {
        send({ type: "result", id, value: ["user", ...runtime.list()] });
        break;
      }
      case "ns-vars": {
        send({
          type: "result",
          id,
          value: Object.keys(runtime.vals(ns)).sort(),
        });
        break;
      }
      case "resolve": {
        const specifier = String(message.specifier ?? "");
        send({
          type: "result",
          id,
          value: runtime.resolve(ns, specifier),
        });
        break;
      }
      case "quit": {
        send({ type: "result", id });
        realExit(0);
        break;
      }
      default: {
        send({
          type: "error",
          id,
          error: {
            name: "Error",
            message: `Unknown realm request: ${message.type}`,
            stack: "",
          },
        });
      }
    }
  } catch (error) {
    send({ type: "error", id, error: errorInfo(error), ns });
  }
}

process.on("message", (message) => {
  void handle(message);
});

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`unhandledRejection: ${format(reason)}\n`);
});
process.on("uncaughtException", (error) => {
  process.stderr.write(`uncaughtException: ${format(error)}\n`);
});

send({
  type: "ready",
  pid: process.pid,
  node: process.version,
  cwd: process.cwd(),
});
