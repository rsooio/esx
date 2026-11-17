import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { suite, test } from "node:test";
import { Realm } from "../realm.ts";

async function makeRealm(cwd = process.cwd()) {
  const output: { text: string; error: boolean }[] = [];
  const realm = await Realm.start({
    cwd,
    onOutput(text, error = false) {
      output.push({ text, error });
    },
  });
  return { realm, output };
}

async function waitFor(predicate: () => boolean, timeout = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) {
      throw new Error("Timed out waiting for output");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function outputText(
  output: { text: string; error: boolean }[],
  isError = false,
) {
  return output
    .filter((entry) => entry.error === isError)
    .map((entry) => entry.text)
    .join("");
}

suite("realm", () => {
  test("evaluates and keeps state", async () => {
    const { realm } = await makeRealm();
    try {
      assert.equal(await realm.eval("1 + 1"), "2");
      assert.equal(await realm.eval("const x = 41; x + 1"), "42");
      assert.equal(await realm.eval("x"), "41");
      assert.ok((await realm.listVariables("user")).includes("x"));
      assert.ok((await realm.listNamespaces()).includes("user"));
      assert.equal(await realm.resolveNamespace("user", "user"), "user");
    } finally {
      await realm.stop();
    }
  });

  test("supports top-level await and classes", async () => {
    const { realm } = await makeRealm();
    try {
      assert.equal(await realm.eval("await Promise.resolve(7)"), "7");
      assert.equal(
        await realm.eval(
          "class A { constructor(v) { this.v = v } m() { return this.v } }; new A(3).m()",
        ),
        "3",
      );
    } finally {
      await realm.stop();
    }
  });

  test("supports destructuring and imports", async () => {
    const { realm } = await makeRealm();
    try {
      assert.equal(
        await realm.eval("const { a, b } = { a: 1, b: 2 }; a + b"),
        "3",
      );
      assert.equal(
        await realm.eval(
          'import { readFile } from "node:fs/promises"; typeof readFile',
        ),
        "'function'",
      );
      assert.equal(
        await realm.eval('typeof (await import("node:fs")).readFileSync'),
        "'function'",
      );
    } finally {
      await realm.stop();
    }
  });

  test("routes console output and errors", async () => {
    const { realm, output } = await makeRealm();
    try {
      assert.equal(await realm.eval('console.log("hello", 1); 42'), "42");
      await waitFor(() => outputText(output) === "hello 1\n");
      assert.equal(outputText(output), "hello 1\n");
      await assert.rejects(
        realm.eval("undefinedVariable"),
        /undefinedVariable is not defined/,
      );
    } finally {
      await realm.stop();
    }
  });

  test("formats objects", async () => {
    const { realm } = await makeRealm();
    try {
      assert.match(
        await realm.eval("({ a: 1, b: [2, 3] })"),
        /\{ a: 1, b: \[ 2, 3 \] \}/,
      );
    } finally {
      await realm.stop();
    }
  });

  test("uses host intrinsics and globals", async () => {
    const { realm } = await makeRealm();
    try {
      assert.equal(await realm.eval("[1] instanceof Array"), "true");
      assert.equal(await realm.eval("({}) instanceof Object"), "true");
      assert.equal(await realm.eval("(() => {}) instanceof Function"), "true");
      assert.equal(
        await realm.eval("Object.getPrototypeOf([]) === Array.prototype"),
        "true",
      );
      assert.equal(await realm.eval("typeof setTimeout"), "'function'");
      assert.equal(await realm.eval("typeof Buffer"), "'function'");
    } finally {
      await realm.stop();
    }
  });

  test("loads a file through the parent API", async () => {
    const dir = await mkdtemp(join(tmpdir(), "esx-realm-load-"));
    try {
      const file = join(dir, "loadme.js");
      await writeFile(
        file,
        'export const loaded = 1;\nconsole.log("loaded file");\n',
      );
      const { realm, output } = await makeRealm(dir);
      try {
        await realm.load(file, "user");
        assert.equal(await realm.eval("loaded"), "1");
        await waitFor(() => outputText(output) === "loaded file\n");
        assert.equal(outputText(output), "loaded file\n");
      } finally {
        await realm.stop();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loads local modules in the realm", async () => {
    const dir = await mkdtemp(join(tmpdir(), "esx-realm-local-"));
    try {
      const modulePath = join(dir, "mod.js");
      await writeFile(
        modulePath,
        [
          'console.log("module loaded");',
          "export let count = 0;",
          "export const test = 1;",
          "export function inc() {",
          "  count++;",
          '  console.log("inc called");',
          "  return count;",
          "}",
        ].join("\n"),
      );
      const url = pathToFileURL(modulePath).href;
      const { realm, output } = await makeRealm(dir);
      try {
        assert.equal(
          await realm.eval(
            `import { count, test, inc } from ${JSON.stringify(url)}; [count, test, inc(), count]`,
          ),
          "[ 0, 1, 1, 1 ]",
        );
        await waitFor(
          () => outputText(output) === "module loaded\ninc called\n",
        );
        assert.equal(outputText(output), "module loaded\ninc called\n");

        assert.equal(await realm.eval("export const test = 2", url), "undefined");
        assert.equal(await realm.eval("test", url), "2");

        assert.equal(
          await realm.eval(
            `const m = await import(${JSON.stringify(url)}); [m.test, m.count]`,
          ),
          "[ 2, 1 ]",
        );
        assert.equal(outputText(output), "module loaded\ninc called\n");
      } finally {
        await realm.stop();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("resolves local imports from the module URL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "esx-realm-nested-"));
    try {
      await writeFile(
        join(dir, "b.js"),
        'console.log("b loaded");\nexport const b = 2;\n',
      );
      await writeFile(
        join(dir, "a.js"),
        'import { b } from "./b.js";\nconsole.log("a loaded");\nexport const a = b + 1;\n',
      );
      const url = pathToFileURL(join(dir, "a.js")).href;
      const { realm, output } = await makeRealm(dir);
      try {
        assert.equal(
          await realm.eval(`import { a } from ${JSON.stringify(url)}; a`),
          "3",
        );
        await waitFor(() => outputText(output) === "b loaded\na loaded\n");
        assert.equal(outputText(output), "b loaded\na loaded\n");
        assert.equal(
          await realm.eval(`import { a } from ${JSON.stringify(url)}; a`),
          "3",
        );
        assert.equal(outputText(output), "b loaded\na loaded\n");
      } finally {
        await realm.stop();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("resolves bare packages and #imports from the file parent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "esx-realm-import-"));
    try {
      await mkdir(join(dir, "node_modules/foo/sub"), { recursive: true });
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          name: "esx-import-test",
          type: "module",
          imports: { "#alias": "./src/alias.js" },
        }),
      );
      await writeFile(
        join(dir, "node_modules/foo/package.json"),
        JSON.stringify({
          name: "foo",
          type: "module",
          exports: {
            ".": { import: "./index.js", require: "./cjs.cjs" },
            "./sub": "./sub/index.js",
          },
        }),
      );
      await writeFile(
        join(dir, "node_modules/foo/index.js"),
        "export const value = 42;\n",
      );
      await writeFile(
        join(dir, "node_modules/foo/cjs.cjs"),
        "module.exports = { value: 99 };\n",
      );
      await writeFile(
        join(dir, "node_modules/foo/sub/index.js"),
        "export const sub = 1;\n",
      );
      await writeFile(
        join(dir, "src/alias.js"),
        "export const value = 77;\n",
      );

      const { realm } = await makeRealm(dir);
      const ns = pathToFileURL(join(dir, "src/main.js")).href;
      try {
        assert.equal(
          await realm.eval('import { value } from "foo"; value', ns),
          "42",
        );
        assert.equal(
          await realm.eval('import { value } from "#alias"; value', ns),
          "77",
        );
        assert.equal(
          await realm.eval('await import("foo/sub").then(m => m.sub)', ns),
          "1",
        );
      } finally {
        await realm.stop();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
