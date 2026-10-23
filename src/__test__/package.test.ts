import test, { suite } from "node:test";
import info from "../../package.json" with { type: "json" };
import { join } from "node:path";
import { load, resolve } from "../package.ts";
import assert from "node:assert";

const pwd = join(import.meta.dirname, "../..")

suite("load", () => {
  test("loads a package from a directory", () => {
    const loaded = load(pwd);
    assert.deepStrictEqual(loaded, { path: join(pwd, "src"), ...info });
  });

  test.expectFailure("throws if the package is already loaded", () => {
    load(pwd);
  });

  test.expectFailure("throws if the package is not found", () => {
    load(join(pwd, "nonexistent"));
  });
});

suite("resolve", () => {
  test("resolves a package name to its path", () => {
    const resolved = resolve(info.name);
    assert.strictEqual(resolved, join(pwd, "src", "index.ts"));
  });

  test("resolves a package name with a path to its path", () => {
    const resolved = resolve(`${info.name}/package`);
    assert.strictEqual(resolved, join(pwd, "src", "package.ts"));
  });

  test.expectFailure("throws if the package is not found", () => {
    resolve("nonexistent");
  });

  test.expectFailure("throws if the file is not found", () => {
    resolve(`${info.name}/nonexistent`);
  });
});
