import { suite, test } from "node:test";
import { transpile } from "../scope.ts";
import assert from "node:assert/strict";

function shouldEqual(name: string, source: string, expected: string) {
  test(name, () => assert.equal(transpile(source), expected));
}

suite("scope", () => {
  shouldEqual("function", `
`, `
`);

//   test("function", () => {
//     const source = `
// function foo() {
//   return bar;
// }
// `
//     const code = transpile(source);
//     assert.equal(code, `
// scope.foo = function foo() {const scope = Object.create(scope);
//   return scope.bar;
// }
// `);
//   });
});
