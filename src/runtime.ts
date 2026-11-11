import { readFile } from "node:fs/promises";
import { compile } from "./transform.ts";
import type { Context } from "node:vm";

export type Namespace = {
  id: string;
  scope: Record<string, any>;
  variables: Record<string, string>;
  exports: Record<string, any>;
}

type RuntimeOptions = {
  context: Context;
  eval(cmd: string, file: string): Promise<any>;
}

export class Runtime {
  private readonly options: RuntimeOptions;
  private readonly namespaces = new Map<string, Namespace>();

  constructor(options: RuntimeOptions) {
    options.context.val = this.val.bind(this);
    options.context.def = this.def.bind(this);
    options.context.set = this.set.bind(this);
    options.context.__import = this.import.bind(this);
    this.options = options;
  }

  eval(source: string, id = "") {
    const { code } = compile(source, id, this.ns(id).variables);
    console.debug(`Evaluating code in namespace ${id}:\n${code}`);
    return this.options.eval(code, id);
  }

  vals(id: string) {
    return this.ns(id).scope;
  }

  list() {
    return [...this.namespaces.keys()].sort();
  }

  resolve(id: string, source: string) {
    if (!source.startsWith(".") && !source.startsWith("/")) return source;
    const url = id.startsWith("file://") ? id : `file://${process.cwd()}/`;
    return new URL(source, url).href; // TODO: show user friendly error
  }

  /*
   * Load a module into the current namespace.
   *
   * @param id The current namespace ID. must be a file URL.
   */
  async load(id: string, source: string) {
    console.debug(`Loading module ${source} into namespace ${id}`);
    if (!source.startsWith("file://")) {
      throw new Error(`Module must be a local file: ${source}`);
    }
    await this.eval(await readFile(new URL(source), "utf-8"), id);
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
    if (source === undefined) {
      if (!Object.prototype.hasOwnProperty.call(this.ns(id).scope, name)) {
        throw new Error(`Variable ${name} is not defined in namespace ${id}`);
      }
      return this.ns(id).scope[name];
    }
    const ns = this.ns(this.resolve(id, source));
    if (name === "*") return ns.scope;
    return ns.exports[name] ?? ns.scope[name];
  }

  private def(id: string, name: string, value: any) {
    const ns = this.ns(id);
    ns.scope[name] = value;
    ns.exports[name] = value;
  }

  private set(id: string, name: string, value: any) {
    this.def(id, name, value);
    return value;
  }

  private async import(id: string, source: string) {
    const resolved = this.resolve(id, source);
    const ns = this.ns(resolved);
    if (Object.keys(ns.scope).length > 0) return ns.scope;
    const module = await import(resolved);
    ns.scope = module;
    Object.keys(module).forEach((key) => {
      ns.exports[key] = module[key];
    });
    return module;
  }
}
