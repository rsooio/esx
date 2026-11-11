import { Session } from "node:inspector";
import { createContext, type Context } from "node:vm";
import { compile } from "./transform.ts";
import { readFile } from "node:fs/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("modules://")) {
      const url = new URL(specifier);
      if (url.searchParams.has("parentURL")) {
        context.parentURL = url.searchParams.get("parentURL")!;
        specifier = url.pathname.slice(1); // remove leading slash
      }
    }
    return nextResolve(specifier, context);
  },
});

const session = new Session();
session.connect();
session.post("Runtime.enable");

const namespaces = new Map<string, Namespace>();

export class Namespace {
  readonly specifier: string;
  readonly id!: number;
  readonly context: Context;

  private readonly namespace: Record<string, any> = {};
  private readonly links: Record<string, (value: unknown) => void> = {};
  private loaded = false;

  constructor(specifier: string) {
    console.debug(`Creating namespace for ${specifier}`);
    this.specifier = specifier;
    session.once("Runtime.executionContextCreated", ({ params }) => {
      (this as any).id = params.context.id;
    });
    this.context = createContext(Object.create(globalThis), {
      name: specifier,
      origin: specifier,
    });
  }

  static get(specifier: string) {
    let ns = namespaces.get(specifier);
    if (!ns) {
      ns = new Namespace(specifier);
      namespaces.set(specifier, ns);
    }
    return ns;
  }

  async eval(source: string, evaluate: (code: string) => Promise<unknown>) {
    const { code, imports, exports } = compile(source);
    for (const i of imports) {
      const source = this.resolve(i.source);
      if (!source.startsWith("file://")) {
        console.debug(`Importing external module ${source}`);
        const specifier = `modules:///${source}?parentURL=${this.url}`;
        const module = await import(specifier);
        if (i.type === "namespace") {
          this.context[i.local] = module;
        } else if (i.type === "default") {
          this.context[i.local] = module.default;
        } else if (i.type === "named") {
          this.context[i.local] = module[i.imported];
        }
      } else {
        console.debug(`Importing namespace ${source}`);
        const ns = Namespace.get(source);
        await ns.load(evaluate);
        if (i.type === "namespace") {
          this.context[i.local] = ns.namespace;
        } else if (i.type === "default" || i.type === "named") {
          ns.link(i.type === "named" ? i.imported : "default", (value) => {
            this.context[i.local] = value;
          });
        }
      }
    }
    const result = await evaluate(code);
    exports.forEach((e) => {
      if (e.type === "default") {
        return this.namespace["default"] = this.context[e.local];
      } else if (e.type === "named" && e.source === undefined) {
        return this.namespace[e.exported] = this.context[e.local];
      }

      // TODO: support re-exports from external modules
      const ns = Namespace.get(this.resolve(e.source!));
      if (e.type === "named" && e.source !== undefined) {
        ns.link(e.local, (value) => this.namespace[e.exported] = value);
      } else if (e.type === "namespace") {
        this.namespace[e.exported] = ns.namespace;
      } else if (e.type === "all") {
        // TODO: auto-update when the source namespace changes
        Object.assign(this.namespace, ns.namespace);
      }
    });
    return result;
  }

  link(name: string, update: (value: unknown) => void): void {
    if (name in this.namespace === false) {
      throw new Error(`Cannot link to non-existent variable: ${name}`);
    }
    this.links[name] = update;
    update(this.namespace[name]);
  }

  private get url() {
    if (this.specifier.startsWith("file://")) return this.specifier;
    return `file://${process.cwd()}/repl`; // can remove repl?
  }

  private resolve(source: string) {
    if (!source.startsWith("./") && !source.startsWith("../")) return source;
    return new URL(source, this.url).href;
  }

  private async load(evaluate: (code: string) => Promise<unknown>) {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.specifier.startsWith("file://")) {
      throw new Error(`Cannot load non-file namespace: ${this.specifier}`);
    }
    try {
      const source = await readFile(new URL(this.specifier), "utf-8");
      const strippedSource = stripTypeScriptTypes(source);
      await this.eval(strippedSource, evaluate);
    } catch (error) {
      this.loaded = false;
      throw error;
    }
  }
}
