import { registerHooks } from "node:module";

const MODULES_SCHEME = "esx-modules://";
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

export function modulesSpecifier(id: string, source: string) {
  const url = new URL(MODULES_SCHEME + "resolve");
  url.searchParams.set("parentURL", id);
  url.searchParams.set("specifier", source);
  return url.href;
}
