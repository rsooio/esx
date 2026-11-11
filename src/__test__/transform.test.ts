import { strict as assert } from "node:assert";
import { suite, test } from "node:test";
import { compile } from "../transform.ts";

function code(source: string) {
  return compile(source, "user").code;
}

suite("compile", () => {
  test("keeps top-level declarations and registers them", () => {
    const output = code("const x = 41; x + 1");
    assert.match(output, /var x = 41/);
    assert.match(output, /def\("user", "x", x\)/);
    assert.match(output, /\(val\("user", "x"\)\) \+ 1/);
  });

  test("supports destructuring", () => {
    const output = code("const {a, b} = {a: 1, b: 2}; a + b");
    assert.match(output, /var \{a, b\} = \{a: 1, b: 2\}/);
    assert.match(output, /def\("user", "a", a\)/);
    assert.match(output, /def\("user", "b", b\)/);
  });

  test("supports classes", () => {
    const output = code("class A { m() { return 1 } } new A().m()");
    assert.match(output, /var A = class A/);
    assert.match(output, /def\("user", "A", A\)/);
    assert.match(output, /new \(val\("user", "A"\)\)\(\)/);
  });

  test("supports assignment and update", () => {
    assert.match(code("let x = 1; x = 2"), /set\("user", "x", 2\)/);
    assert.match(code("let x = 1; x += 2"), /set\("user", "x", \(val\("user", "x"\)\) \+ 2\)/);
    assert.match(code("let x = 1; x++"), /set\("user", "x", \(val\("user", "x"\)\) \+ 1\)/);
  });

  test("leaves require alone", () => {
    assert.match(code("require('node:fs')"), /^require\('node:fs'\)/);
  });

  test("rewrites static imports", () => {
    const output = code("import { readFile } from 'node:fs/promises'; typeof readFile");
    assert.match(output, /await __import\("user", "node:fs\/promises"\)/);
    assert.match(output, /typeof \(val\("user", "readFile", 'node:fs\/promises'\)\)/);
  });

  test("handles exports", () => {
    const output = code("export const x = 1; x");
    assert.doesNotMatch(output, /export/);
    assert.match(output, /var x = 1/);
    assert.match(output, /def\("user", "x", x\)/);
  });
});
