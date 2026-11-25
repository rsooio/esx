import { basename } from "node:path";
import Arborist from "@npmcli/arborist";
import { Transpiler } from "./transform.ts";
import assert from "node:assert/strict";

type Value<T = any> = {
  value: T;
  exported?: boolean;
};

type Module = Record<string, Value>;

export type RuntimeOptions = {
  // global variables to be injected into the runtime environment
  global?: Record<string, any>;

  // import a module, return the module's scope and exports
  import?(specifier: string, parent: string): Promise<Record<string, any> | undefined>;

  // load a module, return the module's code as string
  load?(specifier: string, parent?: string): Promise<string>;

  // support for importing npm packages, for example: "npm:lodash@4.17.21"
  npm?: string | Arborist.Options
}

export class Runtime {
  private readonly transpiler = new Transpiler();
  private readonly options: RuntimeOptions;
  private readonly evaluate: (...args: any[]) => any;
  private readonly args: Record<string, any> = {};
  private readonly modules = new Map<string, Module>();
  private readonly arborist: Arborist | null = null;

  constructor(options: RuntimeOptions) {
    if (options.npm) {
      if (typeof options.npm === "string") options.npm = { path: options.npm };
      this.arborist = new Arborist(options.npm);
      this.arborist.loadActual(); // TODO: handle errors and async
    }
    this.options = options;
    this.args = {
      ...options.global,
      __import: this.import.bind(this),
      val: this.val.bind(this),
      def: this.def.bind(this),
      set: this.def.bind(this), // remove this, use def instead
    }
    this.evaluate = Function(
      ...Object.keys(this.args),
      "return eval(code)",
    ) as (...args: any[]) => any;
  }

  eval(source: string, file: string) {
    const code = this.transpiler.transpile(source, file, true);
    console.debug(`Evaluating code in file ${file}:\n${code}`);

    const sourceURL = `//# sourceURL=${(file).replace(/[\r\n\u2028\u2029]/g, " ")}`;
    const result = this.evaluate(
      `(async function() { ${code}\n})\n${sourceURL}`,
      ...Object.values(this.args),
    );
    return result.value;
  }

  /*
   * Make sure a module is loaded and evaluated, if not already done.
   *
   * @param specifier The module specifier, can be a file URL or a package name.
   * @param parent The parent module specifier, used for resolving relative paths.
   */
  private async import(specifier: string, parent: string) {
    if (this.modules.has(specifier)) return;
    const url = await this.resolve(specifier, parent, true);
    if (url.startsWith("file://") && !url.includes("node_modules")) {
      if (!this.options.load) return;
      this.modules.set(url, {});
      await this.eval(await this.options.load(url, parent), url);
    } else {
      const module = await import(url)
      const values: Module = {};
      for (const name in module) {
        values[name] = { value: values[name], exported: true };
      }
      this.modules.set(url, values);
    }
  }

  private resolve(specifier: string, parent: string, async?: false): string
  private resolve(specifier: string, parent: string, async: true): Promise<string>
  private resolve(specifier: string, parent: string, async = false) {
    if (this.arborist && specifier.startsWith("npm:")) {
      const resolved = this.resolveNpm(specifier);
      if (resolved) return resolved;
      if (async) return this.install(specifier);
      throw new Error(`Cannot resolve ${specifier}`);
    }
    return import.meta.resolve(specifier, parent);
  }

  private async install(specifier: string) {
    assert(this.arborist, "NPM support is not enabled");
    assert(specifier.startsWith("npm:"), "Specifier must start with 'npm:'");
    await this.arborist.loadActual();
    let resolved = this.resolveNpm(specifier);
    if (resolved) return resolved; // try to resolve again
    const pkg = specifier.slice(4, specifier.indexOf("/"));
    await this.arborist.reify({ add: [pkg] });
    resolved = this.resolveNpm(specifier);
    assert(resolved, `Failed to install ${specifier}`);
    return resolved;
  }

  private resolveNpm(specifier: string) {
    assert(this.arborist, "NPM support is not enabled");
    assert(specifier.startsWith("npm:"), "Specifier must start with 'npm:'");

    const [pkg, ...rest] = specifier.slice(4).split("/");
    const [name, version] = pkg.split("@");
    if (!this.arborist.actualTree) return;
    const nodes = [...this.arborist.actualTree?.inventory.query("name", name)];
    const node = nodes.find((node) => node.version === version);
    if (!node) return;
    // TODO: use package config to resolve instead of just returning the path
    return [nodes.values().toArray()[0].path, ...rest].join("/");
  }

  private val(id: string, name: string, source?: string) {
    const module = this.modules.get(source ? this.resolve(id, source) : id);
    if (!module) {
      throw new ReferenceError(`Module ${source ?? id} is not loaded`);
    } else if (source && module[name] && !module[name].exported) {
      throw new ReferenceError(`${name} is not exported from ${basename(id)}`);
    } else if (!module[name]) {
      throw new ReferenceError(`${name} is not defined in ${basename(id)}`);
    }
    return name === "*" ? { value: module } : module[name];
  }

  private def(id: string, name: string, exported = false) {
    const module = this.modules.get(id) ?? {};
    if (!this.modules.has(id)) this.modules.set(id, module);
    module[name] = { exported, value: undefined };
    return module[name];
  }
}
