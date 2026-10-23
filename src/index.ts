import { Session } from "node:inspector";
import { start } from "node:repl";
import { createContext, runInContext, type Context } from "node:vm";
import { load, packages } from "./package.ts";

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
  const context = createContext(Object.create(globalThis));
  session.disconnect();
  if (contextId === undefined) {
    throw new Error("Failed to create execution context");
  }
  return { id: contextId, context };
}

let currentModule: string;
const modules = new Map<string, Module>();

console.log("Welcome to the REPL with namespaces!");
console.log("Type .help for more information.");
const repl = start({
  preview: true,
  // @ts-expect-error type definition is missing, but the option is valid
  allowBlockingCompletions: true,
  eval(cmd, context, filename, callback) {
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
  repl.setPrompt(`${id}> `);
  repl.displayPrompt();
}

repl.defineCommand("add", {
  help: "Add a package to workspace",
  async action(text: string) {
    const dir = join(process.env.HOME!, text);
    try {
      const pkg = await load(dir);
      console.log(`Loaded package ${pkg.name}@${pkg.version} from ${pkg.path}`);
    } catch {
      console.error(`Failed to load package from ${dir}`);
    }
    this.displayPrompt();
  },
});

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

import { readdirSync } from "node:fs";
import { join } from "node:path";

function completePath(prefix: string) {
  const home = process.env.HOME!;
  const parts = prefix.split("/");
  const dir = join(home, parts.slice(0, -1).join("/") || ".");
  const base = parts[parts.length - 1];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.name.startsWith(base) && entry.isDirectory())
      .map((entry) => join(dir, entry.name).slice(home.length + 1));
  } catch {
    return [];
  }
}

const completer = repl.completer.bind(repl);
(repl.completer as typeof completer) = (line, callback) => {
  if (line.startsWith(".ns ")) {
    const prefix = line.match(/^\s*\.ns\s+(\S*)$/)?.[1] ?? "";
    if (!line.includes("/")) {
      const hits = Array.from(packages.keys())
        .filter((name) => name.startsWith(prefix));
      callback(null, [hits, prefix]);
    } else {
      const [name, rest] = prefix.split("/", 2);
      const pkg = packages.get(name);
      if (!pkg) {
        callback(null, [[], prefix]);
      } else {
        const hits = completePath(join(pkg.path, rest));
        callback(null, [
          hits.map((hit) => `${name}/${hit.slice(pkg.path.length + 1)}`),
          prefix,
        ]);
      }
    }
  } else if (line.startsWith(".add ")) {
    const prefix = line.slice(5).trimStart();
    const hits = completePath(prefix);
    callback(null, [hits, prefix]);
  } else {
    completer(line, callback);
  }
}
