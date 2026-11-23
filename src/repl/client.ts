import { start } from "node:repl";
import { Realm } from "../realm.ts";

let ns = "user";

const realm = await Realm.start({
  cwd: process.cwd(),
  onOutput(text, isError = false) {
    if (isError) process.stderr.write(text);
    else process.stdout.write(text);
  },
  onExit(code, signal) {
    console.error(`User realm exited (${code ?? signal ?? "unknown"})`);
  },
});

console.log("Welcome to the REPL with namespaces!");
console.log("Type .help for more information.");

const repl = start({
  prompt: "",
  useGlobal: true,
  preview: false,
  completer: (line, callback) => callback(null, [[], line]),
  writer: (value) => value,
  eval: async (code, _context, _file, callback) => {
    if (code === "\n") return Promise.resolve(undefined);
    realm
      .eval(code, ns)
      .then((result) => callback(null, result))
      .catch((error) => callback(error, undefined));
  },
  handleError(error) {
    console.log(error instanceof Error ? error.message : String(error));
    repl.displayPrompt();
    return "ignore";
  },
});

async function switchNamespace(specifier: string) {
  if (!specifier) {
    console.log(`Current namespace: ${ns}`);
  } else {
    ns = await realm.resolveNamespace(ns, specifier);
    console.log(`Switched to namespace: ${ns}`);
    repl.setPrompt(`${ns}> `);
  }
  repl.displayPrompt();
}

repl.defineCommand("ns", {
  help: "Switch namespace",
  action(specifier: string) {
    void switchNamespace(specifier.trim()).catch((error) => {
      console.log(error instanceof Error ? error.message : String(error));
      repl.displayPrompt();
    });
  },
});

repl.defineCommand("load", {
  help: "Load a module into the current namespace",
  async action(specifier: string) {
    try {
      const resolved = await realm.resolveNamespace(
        ns,
        specifier.trim() || ns,
      );
      await realm.load(resolved, ns);
      console.log(`Loaded module: ${resolved}`);
    } catch (err) {
      console.log(err instanceof Error ? err.message : String(err));
    }
    this.displayPrompt();
  },
});

repl.defineCommand("vars", {
  help: "List variables in the current namespace",
  async action() {
    try {
      const vars = await realm.listVariables(ns);
      if (vars.length === 0) {
        console.log("No variables in the current namespace");
      } else {
        console.log("Variables in the current namespace:");
        for (const v of vars) {
          console.log(`- ${v}`);
        }
      }
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
    }
    this.displayPrompt();
  },
});

repl.on("exit", () => {
  void realm.stop().finally(() => process.exit(0));
});

process.on("exit", () => {
  realm.kill();
});

await switchNamespace("user");
