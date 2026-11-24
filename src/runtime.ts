import { basename } from "node:path";
import { compile } from "./transform.ts";
import Arborist from "@npmcli/arborist";

type Module = {
  scope?: Record<string, any>;
  exports?: Record<string, any>;
  variableMap?: Record<string, string>; // move to compiler
}

type RuntimeOptions = {
  // global variables to be injected into the runtime environment
  global?: Record<string, any>;

  // import a module, return the module's scope and exports
  import?(specifier: string, parent: string): Promise<Module | undefined>;

  // load a module, return the module's code as string
  load?(specifier: string, parent?: string): Promise<string>;

  // support for importing npm packages, for example: "npm:lodash@4.17.21"
  npm?: string | Arborist.Options
}

export class Runtime {
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
    const { code } = compile(source, file, {}, { completion: true });
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
  private async import(specifier: string, parent?: string) {
    if (this.modules.has(specifier)) return;
    const url = this.resolve(specifier, parent);
    if (url.startsWith("file://") && !url.includes("node_modules")) {
      if (!this.options.load) return;
      this.modules.set(url, { scope: {}, exports: {} });
      await this.eval(await this.options.load(url, parent), url);
    } else {
      const module = await import(url);
      this.modules.set(url, { scope: module, exports: module });
    }
  }

  private resolve(specifier: string, parent?: string) {
    if (this.arborist && specifier.startsWith("npm:")) {
      const [pkg, ...rest] = specifier.slice(4).split("/");
      const [name, version] = pkg.split("@");
      const nodes = this.arborist.actualTree?.inventory.query(name, version);
      if (!nodes || nodes.size === 0) {
        throw new Error(`Package ${name}@${version} not found in node_modules`);
      }
      console.log(nodes);
      return [nodes.values().toArray()[0].path, ...rest].join("/");
    }
    return import.meta.resolve(specifier, parent);
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
