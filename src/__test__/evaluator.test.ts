import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { suite, test } from "node:test";
import { Evaluator } from "../evaluator.ts";
import { Runtime } from "../runtime.ts";

async function makeRuntime() {
  const output: { text: string; error: boolean }[] = [];
  const evaluator = await Evaluator.create({
    cwd: process.cwd(),
    onOutput(text, error = false) {
      output.push({ text, error });
    },
  });
  const runtime = new Runtime({
    context: evaluator.context,
    eval: (code, file) => evaluator.evaluate(code, file),
  });
  return { evaluator, runtime, output };
}

suite("evaluator", () => {
  test("evaluates and keeps state", async () => {
    const { evaluator, runtime } = await makeRuntime();
    try {
      assert.equal(await runtime.eval("1 + 1", "user"), "2");
      assert.equal(await runtime.eval("const x = 41; x + 1", "user"), "42");
      assert.equal(await runtime.eval("x", "user"), "41");
    } finally {
      evaluator.dispose();
    }
  });

  test("supports top-level await and classes", async () => {
    const { evaluator, runtime } = await makeRuntime();
    try {
      assert.equal(await runtime.eval("await Promise.resolve(7)", "user"), "7");
      assert.equal(
        await runtime.eval(
          "class A { constructor(v) { this.v = v } m() { return this.v } }; new A(3).m()",
          "user",
        ),
        "3",
      );
    } finally {
      evaluator.dispose();
    }
  });

  test("supports destructuring and imports", async () => {
    const { evaluator, runtime } = await makeRuntime();
    try {
      assert.equal(
        await runtime.eval("const { a, b } = { a: 1, b: 2 }; a + b", "user"),
        "3",
      );
      assert.equal(
        await runtime.eval(
          'import { readFile } from "node:fs/promises"; typeof readFile',
          "user",
        ),
        "'function'",
      );
      assert.equal(
        await runtime.eval(
          'typeof (await import("node:fs")).readFileSync',
          "user",
        ),
        "'function'",
      );
    } finally {
      evaluator.dispose();
    }
  });

  test("routes console output and errors", async () => {
    const { evaluator, runtime, output } = await makeRuntime();
    try {
      assert.equal(await runtime.eval('console.log("hello", 1); 42', "user"), "42");
      assert.deepEqual(output, [{ text: "hello 1\n", error: false }]);
      await assert.rejects(
        runtime.eval("undefinedVariable", "user"),
        /Variable undefinedVariable is not defined/,
      );
    } finally {
      evaluator.dispose();
    }
  });

  test("formats objects", async () => {
    const { evaluator, runtime } = await makeRuntime();
    try {
      assert.match(await runtime.eval("({ a: 1, b: [2, 3] })", "user"), /\{ a: 1, b: \[ 2, 3 \] \}/);
    } finally {
      evaluator.dispose();
    }
  });

  test("resolves bare packages and #imports from the file parent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "esx-import-"));
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

      const evaluator = await Evaluator.create({
        cwd: dir,
        onOutput() {},
      });
      const runtime = new Runtime({
        context: evaluator.context,
        eval: (code, file) => evaluator.evaluate(code, file),
      });
      const ns = pathToFileURL(join(dir, "src/main.js")).href;
      try {
        assert.equal(
          await runtime.eval('import { value } from "foo"; value', ns),
          "42",
        );
        assert.equal(
          await runtime.eval('import { value } from "#alias"; value', ns),
          "77",
        );
        assert.equal(
          await runtime.eval('await import("foo/sub").then(m => m.sub)', ns),
          "1",
        );
      } finally {
        evaluator.dispose();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
