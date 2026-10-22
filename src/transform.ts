import { Parser } from "acorn";
import type { ImportAttribute, Literal, Pattern } from "acorn";
import { ancestor } from "acorn-walk";

type Imported = {
  imported: string;
  local: string;
  source: string;
}

type Exported = {
  exported: string;
  local: string;
  source?: string;
}

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

type Specifier = { name?: string; value?: Literal["value"] };

function toSpecifier(spec: Specifier) {
  return spec.name ?? JSON.stringify(spec.value);
}

function toProperty(key: Specifier, value: Specifier) {
  const name = key.name ?? JSON.stringify(key.value);
  const val = value.name ?? JSON.stringify(value.value);
  return name === val ? name : `${name}: ${val}`;
}

function __import(specifier: Literal["value"], attributes: ImportAttribute[]) {
  const args = attributes.map((a) => toProperty(a.key, a.value));
  if (args.length === 0) return `await __import(${JSON.stringify(specifier)})`;
  return `await __import(${JSON.stringify(specifier)}, { ${args.join(", ")} })`;
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
      const { specifiers } = node;
      const specifier = node.source.value as string;
      const attributes = node.attributes;

      if (specifiers.length === 0) {
        return replace(node, __import(specifier, attributes));
      }

      let namespaceName: string | null = null;
      let defaultName: string | null = null;
      const properties: string[] = [];

      specifiers.forEach((s) => {
        if (s.type === "ImportNamespaceSpecifier") {
          namespaceName = s.local.name;
          imports.push({
            imported: "*",
            local: namespaceName,
            source: specifier,
          });
        } else if (s.type === "ImportDefaultSpecifier") {
          defaultName = s.local.name;
          imports.push({
            imported: "default",
            local: defaultName,
            source: specifier,
          });
        } else {
          properties.push(toProperty(s.imported, s.local));
          imports.push({
            imported: toSpecifier(s.imported),
            local: s.local.name,
            source: specifier,
          });
        }
      });

      if (namespaceName !== null) {
        let out = `var ${namespaceName} = ${__import(specifier, attributes)}`;
        if (defaultName != null) {
          out += `; var ${defaultName} = ${namespaceName}.default`;
        }
        replace(node, out);
      } else {
        if (defaultName !== null) {
          properties.push(`default: ${defaultName}`);
        }
        const importExpr = __import(specifier, attributes);
        replace(node, `var { ${properties.join(", ")} } = ${importExpr}`);
      }
    },
    ImportExpression(node) {
      // TODO: inject auto update code for dynamic import
      replace(node, "__" + source.slice(node.start, node.end));
    },
    ExportNamedDeclaration(node) {
      const { declaration, specifiers } = node;
      if (!declaration) {
        // export { foo, bar } | export { foo, bar } from "module"
        replace(node, "");
        exports.push(
          ...specifiers.map((s) => ({
            exported: toSpecifier(s.exported),
            local: toSpecifier(s.local),
            ...(node.source && { source: node.source.value as string }),
          })),
        );
      } else if (declaration.type === "VariableDeclaration") {
        // export const foo = 42 | export let bar = 43
        const { start, kind } = declaration;
        replace({ start: node.start, end: start });
        replace({ start, end: start + kind.length }, "var");
        exports.push(
          ...declaration.declarations.map(({ id }) => {
            if (id.type !== "Identifier") {
              throw new Error("Only simple variable declarations are supported");
            }
            return {
              exported: id.name,
              local: id.name,
              ...(node.source && { source: node.source.value as string }),
            };
          })
        );
      } else {
        // export function foo() {} | export class Foo {}
        replace({ start: node.start, end: declaration.start });
        exports.push({
          exported: declaration.id.name,
          local: declaration.id.name,
          ...(node.source && { source: node.source.value as string }),
        });
      }
    },
    ExportDefaultDeclaration(node) {
      // export default foo | export default function foo() {}
      const { declaration } = node;
      if (declaration.type === "Identifier") {
        replace(node);
        exports.push({ exported: "default", local: declaration.name });
      } else {
        // export default 42 | export default "foo" | export default { bar: 43 }
        const name = "__default_export__";
        replace({ start: node.start, end: declaration.start }, `var ${name} = `);
        exports.push({ exported: "default", local: name });
      }
    },
    ExportAllDeclaration(node) {
      replace(node, "");
      exports.push({
        exported: node.exported ? toSpecifier(node.exported) : "*",
        local: "*",
        source: node.source.value as string,
      });
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
