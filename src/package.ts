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
  if (!filename) throw new Error(`File not found: ${join(dir, name)}`);
  return join(dir, filename);
}

export function resolve(specifier: string) {
  const [name, path] = specifier.split("/", 2);
  const pkg = packages.get(name);
  if (!pkg) throw new Error(`Package not found: ${name}`);
  const resolved = path ? join(pkg.path, path) : pkg.path;
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) return resolved;
    return findSourceFile(resolved, "index");
  } catch {
    return findSourceFile(dirname(resolved), basename(resolved));
  }
}
