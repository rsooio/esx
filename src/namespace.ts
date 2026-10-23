import { Session } from "node:inspector";
import { createContext, type Context } from "node:vm";
import { compile } from "./transform.ts";
import { resolve } from "./package.ts";

const session = new Session();
session.connect();
session.post("Runtime.enable");

const namespaces = new Map<string, Namespace>();

function getNamespace(id: string): Namespace {
  let ns = namespaces.get(id);
  if (!ns) {
    ns = new Namespace();
    namespaces.set(id, ns);
  }
  return ns;
}

class Namespace {
  readonly id!: number;
  readonly context: Context;
  readonly namespace: Record<string, any> = {};
  readonly links: Record<string, (value: unknown) => void> = {};

  constructor() {
    session.once("Runtime.executionContextCreated", ({ params }) => {
      (this as any).id = params.context.id;
    });
    this.context = createContext({});
  }

  async eval(source: string, cb: (err: Error | null, result?: any) => void) {
    const { code, imports, exports } = compile(source);
    await Promise.all(
      imports.map(async (i) => {
        if (!i.source.startsWith("./")) {
          const module = await import(i.source);
          if (i.type === "namespace") {
            this.context[i.local] = module;
          } else if (i.type === "default") {
            this.context[i.local] = module.default;
          } else if (i.type === "named") {
            this.context[i.local] = module[i.imported];
          }
        } else {
          const ns = getNamespace(i.source);
          resolve(i.source)
          // TODO: execute the source if it hasn't been executed yet
          if (i.type === "namespace") {
            this.context[i.local] = getNamespace(i.source).namespace;
          } else if (i.type === "default" || i.type === "named") {
            ns.link(i.type === "named" ? i.imported : "default", (value) => {
              this.context[i.local] = value;
            });
          }
        }
      })
    );
    // return session.post("Runtime.evaluate", {
    //   expression: code,
    //   contextId: this.id,
    //   returnByValue: true,
    // });
    exports.forEach((e) => {
      if (e.type === "namespace") {
        this.namespace[e.exported] = getNamespace(e.source).namespace;
      } else if (e.type === "default") {
        this.namespace["default"] = this.context[e.local];
      } else if (e.type === "named" && e.source === undefined) {
        this.namespace[e.exported] = this.context[e.local];
      } else if (e.type === "named" && e.source !== undefined) {
        getNamespace(e.source).link(e.local, (value) => {
          this.namespace[e.exported] = value;
        });
      } else if (e.type === "all") {
        // TODO: auto-update when the source namespace changes
        Object.assign(this.namespace, getNamespace(e.source).namespace);
      }
    });
  }

  link(name: string, update: (value: unknown) => void): void {
    if (name in this.namespace === false) {
      throw new Error(`Cannot link to non-existent variable: ${name}`);
    }
    this.links[name] = update;
    update(this.namespace[name]);
  }
}
