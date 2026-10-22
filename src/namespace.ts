import { Session } from "node:inspector";
import { createContext, type Context } from "node:vm";
import { compile } from "./transform.ts";

const session = new Session();
session.connect();
session.post("Runtime.enable");

const namespaces = new Map<string, Namespace>();

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

  eval(source: string): unknown {
    const { code, imports, exports } = compile(source);
    imports.forEach((i) => {
      // TODO: link imports to other namespaces
    });
    exports.forEach((e) => {
      // TODO: update namespace with exports
    });
    return session.post("Runtime.evaluate", {
      expression: code,
      contextId: this.id,
      returnByValue: true,
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
