import { suite, test } from "node:test";
import { compile } from "../transform.ts";
import assert from "node:assert";

suite("import declarations", () => {
  test("named import", () => {
    const { code, imports } = compile('import { x } from "y";');
    assert.strictEqual(code, "");
    assert.deepStrictEqual(imports, [
      { type: "named", imported: "x", local: "x", source: "y" },
    ]);
  });

  test("named import with alias", () => {
    const { code, imports } = compile('import { x as y } from "z";');
    assert.strictEqual(code, "");
    assert.deepStrictEqual(imports, [
      { type: "named", imported: "x", local: "y", source: "z" },
    ]);
  });

  test("multiple named imports", () => {
    const { code, imports } = compile('import { x, y as z } from "a";');
    assert.strictEqual(code, "");
    assert.deepStrictEqual(imports, [
      { type: "named", imported: "x", local: "x", source: "a" },
      { type: "named", imported: "y", local: "z", source: "a" },
    ]);
  });

  test("named and default import", () => {
    const { code, imports } = compile('import x, { y, z as a } from "b";');
    assert.strictEqual(code, "");
    assert.deepStrictEqual(imports, [
      { type: "default", local: "x", source: "b" },
      { type: "named", imported: "y", local: "y", source: "b" },
      { type: "named", imported: "z", local: "a", source: "b" },
    ]);
  });

  test("default import", () => {
    const { code, imports } = compile('import x from "y";');
    assert.strictEqual(code, "");
    assert.deepStrictEqual(imports, [
      { type: "default", local: "x", source: "y" },
    ]);
  });

  test("namespace import", () => {
    const { code, imports } = compile('import * as x from "y";');
    assert.strictEqual(code, "");
    assert.deepStrictEqual(imports, [
      { type: "namespace", local: "x", source: "y" },
    ]);
  });

  test("namespace with default import", () => {
    const { code, imports } = compile('import x, * as y from "z";');
    assert.strictEqual(code, "");
    assert.deepStrictEqual(imports, [
      { type: "default", local: "x", source: "z" },
      { type: "namespace", local: "y", source: "z" },
    ]);
  });
});

suite("import expressions", () => {
  test("import expression", () => {
    const { code } = compile('const x = await import("y")');
    assert.strictEqual(code, `var x = await __import("y")`);
  });
});

suite("export declarations", () => {
  test("named export (variable declaration)", () => {
    const { code, exports } = compile("export const x = 42");
    assert.strictEqual(code, "var x = 42");
    assert.deepStrictEqual(exports, [
      { type: "named", exported: "x", local: "x" },
    ]);
  });

  test.expectFailure("named export (destructuring variable declaration)", () => {
    compile("export const { x, y: z } = obj");
  });

  test("named export (function declaration)", () => {
    const { code, exports } = compile("export function x() {}");
    assert.strictEqual(code, "function x() {}");
    assert.deepStrictEqual(exports, [
      { type: "named", exported: "x", local: "x" },
    ]);
  });

  test("named export (class declaration)", () => {
    const { code, exports } = compile("export class X {}");
    assert.strictEqual(code, "class X {}");
    assert.deepStrictEqual(exports, [
      { type: "named", exported: "X", local: "X" },
    ]);
  });

  test("named export (no declaration)", () => {
    const { code, exports } = compile('export { x, y as z }');
    assert.strictEqual(code, "");
    assert.deepStrictEqual(exports, [
      { type: "named", exported: "x", local: "x" },
      { type: "named", exported: "z", local: "y" },
    ]);
  });

  test("named export (re-export from another module)", () => {
    const { code, exports } = compile('export { x, y as z } from "a"');
    assert.strictEqual(code, "");
    assert.deepStrictEqual(exports, [
      { type: "named", exported: "x", local: "x", source: "a" },
      { type: "named", exported: "z", local: "y", source: "a" },
    ]);
  });

  test("default export (identifier)", () => {
    const { code, exports } = compile("export default x");
    assert.strictEqual(code, "");
    assert.deepStrictEqual(exports, [
      { type: "default", local: "x" },
    ]);
  });

  test("default export (expression)", () => {
    const { code, exports } = compile("export default 42");
    assert.strictEqual(code, "var __default_export__ = 42");
    assert.deepStrictEqual(exports, [
      { type: "default", local: "__default_export__" },
    ]);
  });

  test("export all from another module", () => {
    const { code, exports } = compile('export * from "a"');
    assert.strictEqual(code, "");
    assert.deepStrictEqual(exports, [
      { type: "all", source: "a" },
    ]);
  });

  test("export all with alias from another module", () => {
    const { code, exports } = compile('export * as x from "a"');
    assert.strictEqual(code, "");
    assert.deepStrictEqual(exports, [
      { type: "namespace", exported: "x", source: "a" },
    ]);
  });
});

suite("variable declarations", () => {
  test("const declaration", () => {
    const { code } = compile("const x = 42");
    assert.strictEqual(code, "var x = 42");
  });

  test("let declaration", () => {
    const { code } = compile("let x = 42");
    assert.strictEqual(code, "var x = 42");
  });

  test("var declaration", () => {
    const { code } = compile("var x = 42");
    assert.strictEqual(code, "var x = 42");
  });
});

suite("parse errors", () => {
  test.expectFailure("invalid syntax", () => {
    compile("conts fda = 1;");
  });
});
