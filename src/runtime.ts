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

type Module = {
  scope?: Record<string, any>;
  exports?: Record<string, any>;
  variableMap?: Record<string, string>; // move to compiler
}

type Runtime2Options = {
  // global variables to be injected into the runtime environment
  global?: Record<string, any>;

  // import a module by file and source, return the module's scope and exports
  import?(id: string, source: string): Promise<Module | undefined>;

  // load a module by file and source, return the module's code as string
  load?(id: string, source: string): Promise<string>;
}

export class Runtime2 {
  private readonly options: Runtime2Options;
  private readonly evaluate: (...args: any[]) => any;
  private readonly args: Record<string, any> = {};
  private readonly modules = new Map<string, Module>();

  constructor(options: Runtime2Options) {
    this.options = options;
    this.args = {
      ...options.global,
      __import: this.import.bind(this),
      val: this.val.bind(this),
      def: this.def.bind(this),
      set: this.def.bind(this), // remove this, use def instead
    }
    this.evaluate = Function(
      ...objectKeys(this.args),
      "return eval(code)",
    ) as (...args: any[]) => any;
  }

  eval(source: string, file: string) {
    const { code } = compile(source, file, {}, { completion: true });
    console.debug(`Evaluating code in file ${file}:\n${code}`);

    const sourceURL = `//# sourceURL=${(file).replace(/[\r\n\u2028\u2029]/g, " ")}`;
    const result = this.evaluate(
      `({ value: (async function() { ${code}\n}) })\n${sourceURL}`,
      ...Object.values(this.args),
    );
    return result.value;
  }

  private async import(id: string, source: string) {
    const module = await this.module(id, source);
    if (module) return module.exports ?? {};
    const specifier = this.resolve(id, source);
    if (specifier.startsWith("file://")) {
      if (!this.options.load) return;
      const module: Module = {};
      this.modules.set(specifier, module);
      await this.eval(await this.options.load(id, specifier), specifier);
      return module.exports ?? {};
    } else {
      const module = await import(specifier);
      this.modules.set(specifier, { scope: module, exports: module });
      return module;
    }
  }

  private async module(id: string, source: string) {
    const specifier = this.resolve(id, source);
    if (this.modules.has(specifier)) return this.modules.get(specifier);
    const module = await this.options.import?.(source, id);
    if (!module) return;
    this.modules.set(specifier, module);
    return module;
  }

  private resolve(id: string, source: string) {
    if (!source.startsWith(".") && !source.startsWith("/")) return source;
    const url = id.startsWith("file://") ? id : `file://${process.cwd()}/`;
    return new URLConstructor(source, url).href; // TODO: show user friendly error
  }

  private val(id: string, name: string, source?: string) {
    const module = this.modules.get(source ? this.resolve(id, source) : id);
    if (!module?.scope || !Object.hasOwn(module.scope, name)) {
      throw new ReferenceError(`${name} is not defined in ${basename(id)}`);
    }
    return name === "*" ? module.scope : module.scope[name];
  }

  private def(id: string, name: string, value: any, exports = false) {
    const module = this.modules.get(id) ?? {};
    if (!this.modules.has(id)) this.modules.set(id, module);
    module.scope ??= {};
    module.scope[name] = value;
    if (exports) {
      module.exports ??= {};
      module.exports[name] = value;
    }
    return value;
  }
}
