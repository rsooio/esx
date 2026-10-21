import { createContext, runInContext, type Context } from "node:vm";

export class Runtime {
  private readonly modules = new Map<string, Context>();

  public context(id: string): Context {
    return this.modules.getOrInsertComputed(id, () => createContext({}));
  }

  public async eval(id: string, code: string): Promise<unknown> {
    const context = this.context(id);
    runInContext(code, context, {
      filename: id,
    });
  }
}
