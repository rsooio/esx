import { suite, test } from "node:test";
import { compile } from "../transform.ts";
import assert from "node:assert";

suite("import declarations", () => {
  test("named import", () => {
    const { code, imports } = compile('import { x } from "y";');
    assert.strictEqual(code, `var { x } = await __import("y")`);
    assert.deepStrictEqual(imports, [
      { imported: "x", local: "x", source: "y" },
    ]);
  });

  test("named import with alias", () => {
    const { code, imports } = compile('import { x as y } from "z";');
    assert.strictEqual(code, `var { x: y } = await __import("z")`);
    assert.deepStrictEqual(imports, [
      { imported: "x", local: "y", source: "z" },
    ]);
  });

  test("named import with attributes", () => {
    const source = 'import { x } from "y" with { type: "json" };'
    const expected = `var { x } = await __import("y", { type: "json" })`;
    const { code, imports } = compile(source);
    assert.strictEqual(code, expected);
    assert.deepStrictEqual(imports, [
      { imported: "x", local: "x", source: "y" },
    ]);
  });

  test("multiple named imports", () => {
    const { code, imports } = compile('import { x, y as z } from "a";');
    const expected = `var { x, y: z } = await __import("a")`;
    assert.strictEqual(code, expected);
    assert.deepStrictEqual(imports, [
      { imported: "x", local: "x", source: "a" },
      { imported: "y", local: "z", source: "a" },
    ]);
  });

  test("named and default import", () => {
    const { code, imports } = compile('import x, { y, z as a } from "b";');
    const expected = `var { y, z: a, default: x } = await __import("b")`;
    assert.strictEqual(code, expected);
    assert.deepStrictEqual(imports, [
      { imported: "default", local: "x", source: "b" },
      { imported: "y", local: "y", source: "b" },
      { imported: "z", local: "a", source: "b" },
    ]);
  });

  test("default import", () => {
    const { code, imports } = compile('import x from "y";');
    assert.strictEqual(code, `var { default: x } = await __import("y")`);
    assert.deepStrictEqual(imports, [
      { imported: "default", local: "x", source: "y" },
    ]);
  });

  test("namespace import", () => {
    const { code, imports } = compile('import * as x from "y";');
    assert.strictEqual(code, `var x = await __import("y")`);
    assert.deepStrictEqual(imports, [
      { imported: "*", local: "x", source: "y" },
    ]);
  });

  test("namespace with default import", () => {
    const { code } = compile('import x, * as y from "z";');
    const expected = `var y = await __import("z"); var x = y.default`;
    assert.strictEqual(code, expected);
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
    assert.deepStrictEqual(exports, [{ exported: "x", local: "x" }]);
  });

  test.expectFailure("named export (destructuring variable declaration)", () => {
    compile("export const { x, y: z } = obj");
  });

  test("named export (function declaration)", () => {
    const { code, exports } = compile("export function x() {}");
    assert.strictEqual(code, "function x() {}");
    assert.deepStrictEqual(exports, [{ exported: "x", local: "x" }]);
  });

  test("named export (class declaration)", () => {
    const { code, exports } = compile("export class X {}");
    assert.strictEqual(code, "class X {}");
    assert.deepStrictEqual(exports, [{ exported: "X", local: "X" }]);
  });

  test("named export (no declaration)", () => {
    const { code, exports } = compile('export { x, y as z }');
    assert.strictEqual(code, "");
    assert.deepStrictEqual(exports, [
      { exported: "x", local: "x" },
      { exported: "z", local: "y" },
    ]);
  });

  test("named export (re-export from another module)", () => {
    const { code, exports } = compile('export { x, y as z } from "a"');
    assert.strictEqual(code, "");
    assert.deepStrictEqual(exports, [
      { exported: "x", local: "x", source: "a" },
      { exported: "z", local: "y", source: "a" },
    ]);
  });

  test("default export (identifier)", () => {
    const { code, exports } = compile("export default x");
    assert.strictEqual(code, "");
    assert.deepStrictEqual(exports, [{ exported: "default", local: "x" }]);
  });

  test("default export (expression)", () => {
    const { code, exports } = compile("export default 42");
    assert.strictEqual(code, "var __default_export__ = 42");
    assert.deepStrictEqual(exports, [
      { exported: "default", local: "__default_export__" },
    ]);
  });

  test("export all from another module", () => {
    const { code, exports } = compile('export * from "a"');
    assert.strictEqual(code, "");
    assert.deepStrictEqual(exports, [
      { exported: "*", local: "*", source: "a" },
    ]);
  });

  test("export all with alias from another module", () => {
    const { code, exports } = compile('export * as x from "a"');
    assert.strictEqual(code, "");
    assert.deepStrictEqual(exports, [
      { exported: "x", local: "*", source: "a" },
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
