import { readFile } from "node:fs/promises";
import { compile } from "./transform.ts";
import { PassThrough } from "node:stream";
import type { Context } from "node:vm";

const pass = new PassThrough();

export type Namespace = {
  id: string;
  scope: Record<string, any>;
  variables: Record<string, string>;
  exports: Record<string, string>;
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
    // TODO: destructuring
    if (source === undefined) {
      if (!this.ns(id).scope.hasOwnProperty(name)) {
        throw new Error(`Variable ${name} is not defined in namespace ${id}`);
      }
      return this.ns(id).scope[name];
    }
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
