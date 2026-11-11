import fs from "node:fs";
import { basename, dirname, join } from "node:path";

type Package = {
  path: string;
  name: string;
  version: string;
}

export const packages = new Map<string, Package>();

export function load(dir: string): Package {
  const info = JSON.parse(fs.readFileSync(`${dir}/package.json`, "utf8"));
  if (packages.has(info.name)) {
    // TODO: only throw if the path is different
    throw new Error(`Package already loaded: ${info.name}`);
  }
  const path = fs.existsSync(join(dir, "src")) ? join(dir, "src") : dir;
  const pkg = { path: fs.realpathSync(path), ...info };
  packages.set(info.name, pkg);
  return pkg;
}

function findSourceFile(dir: string, name: string) {
  const files = fs.readdirSync(dir);
  const filename = [".ts", ".js"]
    .map((ext) => `${name}${ext}`)
    .find((file) => files.includes(file));
  if (filename) return join(dir, filename);
}

export function resolve(source: string, parent?: string) {
  const [name, path] = source.split("/", 2);
  const pkg = packages.get(name);
  if (!pkg) return;
  const resolved = path ? join(pkg.path, path) : pkg.path;
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) return resolved;
    return findSourceFile(resolved, "index");
  } catch {
    return findSourceFile(dirname(resolved), basename(resolved));
  }
}

function resolvePackage(source: string) {
  let pkg: Package | undefined;
  for (const candidate of packages.values()) {
    const { name } = candidate;
    if (source !== name && !source.startsWith(name + "/")) continue;
    if (!pkg || name.length > pkg.name.length) pkg = candidate;
  }
  if (!pkg) return;
  if (source === pkg.name) return pkg.path;
  return join(pkg.path, source.slice(pkg.name.length + 1));
}

function _resolve(source: string, parent?: string) {
  if (!source.startsWith("./") && !source.startsWith("../")) {
    return source;
  }
  if (!parent) {
    throw new Error(`Cannot resolve relative specifier ${source} without a parent`);
  }
  return join(parent, "..", source);
}

export function specifierFromPath(path: string) {
  // Find the longest matching package path prefix
  const specifiers = Array.from(packages.values())
    .filter((pkg) => path.startsWith(pkg.path))
    .sort((a, b) => b.path.length - a.path.length);
  if (specifiers.length > 0) {
    return specifiers[0].name + path.slice(specifiers[0].path.length);
  }
  throw new Error(`Path not in any loaded package: ${path}`);
}
