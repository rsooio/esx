import { Session } from "node:inspector";
import { start } from "node:repl";
import { createContext, runInContext, type Context } from "node:vm";

type Module = {
  id: number;
  context: Context;
};

function createModule(): Module {
  const session = new Session();
  session.connect();
  session.post("Runtime.enable");
  let contextId: number | undefined;
  session.once("Runtime.executionContextCreated", ({ params }) => {
    contextId = params.context.id;
  });
  const context = createContext({});
  session.disconnect();
  if (contextId === undefined) {
    throw new Error("Failed to create execution context");
  }
  return { id: contextId, context };
}

let currentModule: string;
const modules = new Map<string, Module>();

const repl = start({
  preview: true,
  // @ts-expect-error type definition is missing, but the option is valid
  allowBlockingCompletions: true,
  eval: (cmd, context, filename, callback) => {
    try {
      const value = runInContext(cmd, context, {
        filename,
        displayErrors: true,
      });
      callback(null, value);
    } catch (err: any) {
      callback(err, null);
    }
  },
});

const kContextId = Object.getOwnPropertySymbols(repl)
  .find((s) => s.description === 'contextId')!;

function activateModule(id: string): void {
  currentModule = id;
  // const context = modules.getOrInsertComputed(id, () => createContext({}));
  let module = modules.get(id);
  if (!module) {
    module = createModule();
    modules.set(id, module);
  }
  Object.assign(repl, { [kContextId]: module.id, context: module.context });
  // repl.context = context;
  // repl[kContextId] = context;
  repl.setPrompt(`${id}> `);
  repl.displayPrompt();
}

repl.defineCommand("ns", {
  help: "Switch namespace",
  action(text: string) {
    if (!text) {
      console.log(`Current namespace: ${currentModule}`);
    } else {
      activateModule(text);
    }
    this.displayPrompt();
  },
});

const completer = repl.completer.bind(repl);
(repl.completer as typeof completer) = (line, callback) => {
  if (line.startsWith(".ns ")) {
    const prefix = line.match(/^\s*\.ns\s+(\S*)$/)?.[1] ?? "";
    const hits = Array.from(modules.keys())
      .filter((name) => name.startsWith(prefix))
      .map((name) => `${line.slice(0, -prefix.length)}${name}`);
    callback(null, [hits, line]);
  }
  return completer(line, callback);
}

activateModule("user");
