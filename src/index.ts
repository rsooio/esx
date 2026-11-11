import { start } from "node:repl";
import { load, packages } from "./package.ts";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Namespace } from "./namespace.ts";

if (!process.env.DEBUG) {
  console.debug = () => {};
}

console.log("Welcome to the REPL with namespaces!");
console.log("Type .help for more information.");
const repl = start({
  prompt: "",
  preview: true,
  // @ts-expect-error type definition is missing, but the option is valid
  allowBlockingCompletions: true,
});

const kContextId = Object.getOwnPropertySymbols(repl)
  .find((s) => s.description === 'contextId')!;

repl.defineCommand("add", {
  help: "Add a package to workspace",
  async action(text: string) {
    const dir = join(process.env.HOME!, text);
    try {
      const pkg = load(dir);
      console.log(`Loaded package ${pkg.name}@${pkg.version} from ${pkg.path}`);
    } catch {
      console.error(`Failed to load package from ${dir}`);
    }
    this.displayPrompt();
  },
});

const main = Namespace.get("user");
let ns: Namespace = main;

function switchNamespace(specifier: string) {
  if (!specifier) {
    console.log(`Current namespace: ${ns?.specifier ?? "none"}`);
  } else {
    ns = Namespace.get(specifier);
    console.log(`Switched to namespace: ${ns.specifier}`);
    repl.setPrompt(`${ns.specifier}> `);
    Object.assign(repl, { [kContextId]: ns.id, context: ns.context });
  }
  repl.displayPrompt()
}

switchNamespace("user");
repl.defineCommand("ns", {
  help: "Switch namespace",
  action: switchNamespace,
});

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
    // FIXME: support namespaces, packages and paths in a more robust way
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

const originalEval = repl.eval.bind(repl);
(repl.eval as typeof originalEval) = (cmd, context, file, cb) => {
  if (ns) {
    ns.eval(cmd, (code) => new Promise((resolve, reject) => {
      originalEval(code, context, file, (err, result) => {
        err ? reject(err) : resolve(result);
      });
    })).then((result) => cb(null, result), (err) => cb(err, null));
  } else {
    originalEval(cmd, context, file, cb);
  }
}

repl.defineCommand("vars", {
  help: "List variables in the current namespace",
  action() {
    if (!ns) {
      console.log("No namespace selected");
      this.displayPrompt();
      return;
    }
    const vars = Object.keys(ns.context).sort();
    if (vars.length === 0) {
      console.log("No variables in the current namespace");
    } else {
      console.log("Variables in the current namespace:");
      for (const v of vars) {
        console.log(`- ${v}`);
      }
    }
    this.displayPrompt();
  },
})
