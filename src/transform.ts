import { Parser, type Literal } from "acorn";
import { ancestor } from "acorn-walk";

type Imported =
  | { type: "namespace"; local: string; source: string }
  | { type: "default"; local: string; source: string }
  | { type: "named"; imported: string; local: string; source: string }
  | { type: "side-effect"; source: string };

type Exported =
  | { type: "namespace"; exported: string; source: string }
  | { type: "default"; local: string }
  | { type: "named"; exported: string; local: string; source?: string }
  | { type: "all"; source: string };

const parser = Parser.extend((BaseParser) => class extends BaseParser {
  // @ts-expect-error
  raiseRecoverable(pos, message) {
    if (/^Export '.*' is not defined$/.test(message)) {
      return;
    }
    // @ts-expect-error
    return super.raiseRecoverable(pos, message);
  }
});

function nameof(specifier: { name?: string; value?: Literal["value"] }) {
  return specifier.name ?? JSON.stringify(specifier.value);
}

export function compile(source: string) {
  const ast = parser.parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
  });

  const exports: Exported[] = [];
  const imports: Imported[] = [];

  const edits: { start: number; end: number; text: string }[] = [];

  function replace(node: { start: number; end?: number }, text = "") {
    edits.push({ start: node.start, end: node.end ?? node.start, text });
  }

  ancestor(ast, {
    ImportDeclaration(node) {
      const source = node.source.value as string;
      const items = node.specifiers.map((s): Imported => {
        const base = { local: s.local.name, source };
        switch (s.type) {
          case "ImportNamespaceSpecifier":
            return { ...base, type: "namespace" };
          case "ImportDefaultSpecifier":
            return { ...base, type: "default" };
          case "ImportSpecifier":
            return { ...base, type: "named", imported: nameof(s.imported) };
        }
      });
      if (!items.length) items.push({ type: "side-effect", source });
      imports.push(...items);
      replace(node);
    },
    ImportExpression(node) {
      // TODO: inject auto update code for dynamic import
      replace({ start: node.start }, "__");
    },
    ExportNamedDeclaration(node) {
      const { declaration, specifiers } = node;
      if (!declaration) {
        // export { foo, bar } | export { foo, bar } from "module"
        replace(node, "");
        exports.push(
          ...specifiers.map((s): Exported => ({
            type: "named",
            exported: nameof(s.exported),
            local: nameof(s.local),
            source: node.source?.value as string,
          }))
        );
      } else if (declaration.type === "VariableDeclaration") {
        // export const foo = 42 | export let bar = 43
        const { start, kind } = declaration;
        replace({ start: node.start, end: start });
        replace({ start, end: start + kind.length }, "var");
        exports.push(
          ...declaration.declarations.map(({ id }): Exported => {
            if (id.type !== "Identifier") {
              throw new Error("Only simple variable declarations are supported");
            }
            return {
              type: "named",
              exported: id.name,
              local: id.name,
              source: node.source?.value as string,
            };
          })
        );
      } else {
        // export function foo() {} | export class Foo {}
        replace({ start: node.start, end: declaration.start });
        exports.push({
          type: "named",
          exported: declaration.id.name,
          local: declaration.id.name,
          source: node.source?.value as string,
        });
      }
    },
    ExportDefaultDeclaration(node) {
      // export default foo | export default function foo() {}
      const { declaration } = node;
      if (declaration.type === "Identifier") {
        replace(node);
        exports.push({ type: "default", local: declaration.name });
      } else {
        // export default 42 | export default "foo" | export default { bar: 43 }
        const name = "__default_export__";
        replace({ start: node.start, end: declaration.start }, `var ${name} = `);
        exports.push({ type: "default", local: name });
      }
    },
    ExportAllDeclaration(node) {
      replace(node, "");
      const source = node.source.value as string;
      exports.push(
        node.exported
          ? { type: "namespace", exported: nameof(node.exported), source }
          : { type: "all", source }
      );
    },
    VariableDeclaration(node, _state, ancestors) {
      if (ancestors.length !== 2) return;
      const { start, kind } = node;
      if (kind === "const" || kind === "let") {
        replace({ start, end: start + kind.length }, "var");
      }
    },
  });

  edits.sort((a, b) => b.start - a.start);
  edits.forEach(({ start, end, text }) => {
    source = source.slice(0, start) + text + source.slice(end);
  });

  return { code: source, imports, exports }
}
