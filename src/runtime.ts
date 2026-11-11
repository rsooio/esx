import { compile } from "./t.ts";
import { start, type REPLServer } from "node:repl";
import { PassThrough } from "node:stream";

const pass = new PassThrough();

export type Namespace = {
  id: string;
  scope: Record<string, any>;
  variables: Record<string, string>;
  exports: Record<string, string>;
}

export class Runtime {
  private readonly repl: REPLServer;
  private readonly namespaces = new Map<string, Namespace>();

  constructor(repl = start({ input: pass, output: pass })) {
    repl.context.val = this.val.bind(this);
    repl.context.def = this.def.bind(this);
    this.repl = repl;
  }

  eval(source: string, id = "") {
    const { code } = compile(source, id, this.ns(id).variables);
    console.log(`Evaluating code for ${id}:\n${code}`);
    // FIXME: use repl's eval instead of runInContext to support top-level await
    return new Promise((resolve, reject) => {
      this.repl.eval(code, this.repl.context, id, (err, result) => {
        err ? reject(err) : resolve(result);
      });
    });
  }

  private resolve(id: string, source: string) {
    if (!source.startsWith("./") && !source.startsWith("../")) return source;
    const url = id.startsWith("file://") ? id : `file://${process.cwd()}/`;
    return new URL(source, url).href;
  }

  private ns(id: string) {
    let ns = this.namespaces.get(id);
    if (!ns) {
      ns = { id, scope: {}, variables: {}, exports: {} };
      this.namespaces.set(id, ns);
    }
    return ns;
  }

  private val(id: string, name: string, source?: string) {
    // TODO: destructuring
    if (source === undefined) return this.ns(id).scope[name];
    // FIXME: exports is a name mapping, not a value mapping
    return this.ns(this.resolve(id, source)).exports[name];
  }

  private def(id: string, name: string, value: any) {
    // TODO: export
    this.ns(id).scope[name] = value;
  }

  private async import(id: string, source: string) {
    const resolved = this.resolve(id, source);
    if (this.namespaces.has(resolved)) return;
    if (!resolved.startsWith("file://")) {
      const module = await import(resolved);
      const ns = this.ns(resolved);
      ns.scope = module;
      Object.keys(module).forEach((key) => ns.exports[key] = key);
    }
  }
}

const runtime = new Runtime();

runtime.eval("await new Promise((resolve) => setTimeout(resolve, 1000))");

// runtime.eval("const x = 42", "file:///test.ts");
// console.log(await runtime.eval("x", "file:///test.ts")); // 42
// runtime.eval("const x = 43", "file:///test.ts");
// console.log(await runtime.eval("x", "file:///test.ts")); // 43
// runtime.eval("const y = 44", "file:///test2.ts");
// console.log(await runtime.eval("y", "file:///test2.ts")); // 44
// console.log(await runtime.eval("x", "file:///test2.ts")); // undefined
// console.log(await runtime.eval("x", "file:///test.ts")); // 43
