import { start } from "node:repl";
import { Runtime } from "./runtime.ts";

if (!process.env.DEBUG) {
  console.debug = () => {};
}

let ns = "user";

console.log("Welcome to the REPL with namespaces!");
console.log("Type .help for more information.");
const repl = start({
  prompt: "",
  preview: false,
  completer: (line: string, callback: any) => callback(null, [[], line]),
  handleError(error: any) {
    console.log(error instanceof Error ? error.message : String(error));
    return "ignore";
  },
} as any);

const originalEval = repl.eval.bind(repl);
const runtime = new Runtime({
  context: repl.context,
  eval(cmd, file) {
    return new Promise((resolve, reject) => {
      originalEval(cmd, repl.context, file, (err, result) => {
        err ? reject(err) : resolve(result);
      });
    });
  },
});
(repl.eval as typeof originalEval) = (cmd, _context, _file, callback) => {
  runtime.eval(cmd, ns)
    .then((result) => callback(null, result))
    .catch((err) => callback(err, undefined));
}

function switchNamespace(specifier: string) {
  if (!specifier) {
    console.log(`Current namespace: ${ns}`);
  } else {
    ns = runtime.resolve(ns, specifier);
    console.log(`Switched to namespace: ${ns}`);
    repl.setPrompt(`${ns}> `);
  }
  repl.displayPrompt();
}

switchNamespace("user");
repl.defineCommand("ns", {
  help: "Switch namespace",
  action: switchNamespace,
});

repl.defineCommand("load", {
  help: "Load a module into the current namespace",
  async action(specifier: string) {
    try {
      const resolved = runtime.resolve(ns, specifier.trim() || ns);
      await runtime.load(ns, resolved);
      console.log(`Loaded module: ${resolved}`);
    } catch (err) {
      console.log(err instanceof Error ? err.message : String(err));
    }
    this.displayPrompt();
  },
});

repl.defineCommand("vars", {
  help: "List variables in the current namespace",
  action() {
    if (!ns) {
      console.log("No namespace selected");
      this.displayPrompt();
      return;
    }
    const vars = Object.keys(runtime.vals(ns)).sort();
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
});
