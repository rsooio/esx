import { strict as assert } from "node:assert";
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
});
