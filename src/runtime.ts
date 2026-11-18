import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { compile } from "./transform.ts";
import { modulesSpecifier } from "./module.ts";

const arraySort = Array.prototype.sort;
const arrayForEach = Array.prototype.forEach;
const objectKeys = Object.keys;
const hasOwn = Object.prototype.hasOwnProperty;
const URLConstructor = URL;

const inspectOptions = {
  colors: false,
  depth: 4,
  maxArrayLength: 100,
  breakLength: 100,
};

const evaluate = Function(
  "code",
  "val",
  "def",
  "set",
  "__import",
  "__importDynamic",
  "require",
  "__dirname",
  "__filename",
  "module",
  "exports",
  "return eval(code)",
) as (...args: any[]) => any;

export type Namespace = {
  id: string;
  scope: Record<string, any>;
  variables: Record<string, string>;
  exports: Record<string, any>;
};

export type RuntimeOptions = {
  cwd: string;
};

export class Runtime {
  private readonly options: RuntimeOptions;
  private readonly namespaces = new Map<string, Namespace>();

  constructor(options: RuntimeOptions) {
    this.options = options;
  }

  async eval(source: string, id = "") {
    const { code } = compile(source, id, this.ns(id).variables, {
      completion: true,
    });
    console.debug(`Evaluating code in namespace ${id}:\n${code}`);

    const dir = id.startsWith("file://")
      ? dirname(fileURLToPath(id))
      : this.options.cwd;
    const require = createRequire(pathToFileURL(join(dir, "__esx__.js")));
    const __dirname = dir;
    const __filename = join(dir, "__esx__.js");
    const module = { exports: {} };
    const exports = module.exports;
    const args = [
      this.val.bind(this),
      this.def.bind(this),
      this.set.bind(this),
      this.import.bind(this),
      this.import.bind(this),
      require,
      __dirname,
      __filename,
      module,
      exports,
    ];
    const sourceURL = `//# sourceURL=${(id || "esx").replace(/[\r\n\u2028\u2029]/g, " ")}`;
    const fn = evaluate(
      `(async function() { ${code}\n})\n${sourceURL}`,
      ...args,
    );

    return inspect(await fn.call(globalThis), inspectOptions);
  }

  vals(id: string) {
    return this.ns(id).scope;
  }

  list() {
    return arraySort.call([...this.namespaces.keys()]);
  }

  resolve(id: string, source: string) {
    if (!source.startsWith(".") && !source.startsWith("/")) return source;
    const url = id.startsWith("file://") ? id : `file://${process.cwd()}/`;
    return new URLConstructor(source, url).href; // TODO: show user friendly error
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
    await this.eval(await readFile(new URLConstructor(source), "utf-8"), id);
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
      if (!hasOwn.call(this.ns(id).scope, name)) {
        throw new ReferenceError(`${name} is not defined in ${basename(id)}`);
      }
      return this.ns(id).scope[name];
    }
    const ns = this.ns(this.module(id, source));
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
    const specifier = this.module(id, source);
    const loaded = this.namespaces.has(specifier);
    if (loaded) return this.namespaces.get(specifier)!.scope;
    const ns = this.ns(specifier);
    if (specifier.startsWith("file://")) {
      await this.load(specifier, specifier);
      return ns.scope;
    } else {
      const module = await import(specifier);
      ns.scope = module;
      arrayForEach.call(objectKeys(module), (name) => {
        ns.exports[name] = module[name];
      });
      return module;
    }
  }

  private module(id: string, source: string) {
    const specifier = this.resolve(id, source);
    const direct = /^file:\/\/|^node:|^data:/.test(specifier);
    if (!direct) return modulesSpecifier(id, specifier);
    return specifier;
  }
}
