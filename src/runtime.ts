import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as nodeModule from "node:module";
import { pathToFileURL } from "node:url";
import type { Context } from "node:vm";
import { compile } from "./transform.ts";

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

const MODULES_SCHEME = "esx-modules://";
const registerHooks = (nodeModule as any).registerHooks as
  | ((hooks: {
      resolve(
        specifier: string,
        context: any,
        nextResolve: (specifier: string, context: any) => any,
      ): any;
    }) => void)
  | undefined;

let hooksRegistered = false;

function registerModuleHooks() {
  if (hooksRegistered || typeof registerHooks !== "function") return;
  hooksRegistered = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!specifier.startsWith(MODULES_SCHEME)) {
        return nextResolve(specifier, context);
      }

      const url = new URL(specifier);
      const realSpecifier = url.searchParams.get("specifier");
      const parentURL = url.searchParams.get("parentURL");
      if (!realSpecifier) {
        return nextResolve(specifier, context);
      }

      return nextResolve(realSpecifier, {
        ...context,
        parentURL: parentURL ?? context.parentURL,
      });
    },
  });
}

registerModuleHooks();

export class Runtime {
  private readonly options: RuntimeOptions;
  private readonly namespaces = new Map<string, Namespace>();

  constructor(options: RuntimeOptions) {
    options.context.val = this.val.bind(this);
    options.context.def = this.def.bind(this);
    options.context.set = this.set.bind(this);
    options.context.__import = this.import.bind(this);
    options.context.__importDynamic = this.import.bind(this);
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
    const ns = this.ns(this.moduleId(id, source));
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
    const key = this.moduleId(id, source);
    const ns = this.ns(key);
    if (Object.keys(ns.scope).length > 0) return ns.scope;

    const resolved = this.resolve(id, source);
    const direct =
      resolved.startsWith("file://") ||
      resolved.startsWith("node:") ||
      resolved.startsWith("data:") ||
      typeof registerHooks !== "function";

    const specifier = direct
      ? resolved
      : this.modulesSpecifier(id, resolved);

    const module = await import(specifier);
    ns.scope = module;
    Object.keys(module).forEach((name) => {
      ns.exports[name] = module[name];
    });
    return module;
  }

  private parentURL(id: string) {
    return id.startsWith("file://")
      ? id
      : pathToFileURL(join(process.cwd(), "__esx__.js")).href;
  }

  private moduleId(id: string, source: string) {
    const resolved = this.resolve(id, source);
    if (
      resolved.startsWith("file://") ||
      resolved.startsWith("node:") ||
      resolved.startsWith("data:")
    ) {
      return resolved;
    }
    return `${this.parentURL(id)}|${resolved}`;
  }

  private modulesSpecifier(id: string, source: string) {
    const url = new URL(MODULES_SCHEME + "resolve");
    url.searchParams.set("parentURL", this.parentURL(id));
    url.searchParams.set("specifier", source);
    return url.href;
  }
}
