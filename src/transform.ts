import { parse, type ImportAttribute, type Literal, type Node } from "acorn";
import { ancestor } from "acorn-walk";

function __import(specifier: Literal["value"], attributes: ImportAttribute[]) {
  const args = attributes.map(({ key, value }) => {
    const name = key.type === "Literal" ? key.value : key.name;
    return `${JSON.stringify(name)}: ${JSON.stringify(value.value)}`;
  });

  return `await __import(${JSON.stringify(specifier)}, { ${args.join(", ")} })`;
}

export function compile(source: string) {
  const ast = parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
  });

  const edits: { start: number; end: number; text: string }[] = [];

  function replace(node: Node, text: string) {
    return edits.push({ start: node.start, end: node.end, text });
  }

  ancestor(ast, {
    ImportDeclaration(node) {
      const { specifiers } = node;
      const specifier = node.source.value;
      const attributes = node.attributes;

      if (specifiers.length === 0) {
        return replace(node, __import(specifier, attributes));
      }

      const imports = specifiers.map((s) => {
        if (s.type === "ImportNamespaceSpecifier") {
          return `const ${s.local.name} = ${
            __import(specifier, attributes)
          }`;
        } else if (s.type === "ImportDefaultSpecifier") {
          return `const { default: ${s.local.name} } = ${
            __import(specifier, attributes)
          }`;
        } else {
          const name = s.imported.type === "Identifier"
            ? s.imported.name
            : s.imported.value;
          return `const { ${name}: ${s.local.name} } = ${
            __import(specifier, attributes)
          }`;
        }
      });

      return replace(node, imports.join("\n"));
    },
    ImportExpression(node) {
      return "__" + source.slice(node.start, node.end);
    },
    ExportNamedDeclaration(node) {
      const { declaration, specifiers } = node;
      if (declaration) {
        // `export const x = 1` becomes `const x = 1; __export({ x })`
        let out = source.slice(node.start + 7, node.end);
        const name = source.slice(declaration.start, declaration.end);
        out += `__export({ ${name} })`;
        return replace(node, out);
      } else {
        // `export { x, y as z }` becomes `__export({ x: x, z: y })`
        const exports = specifiers.map((s) => {
          const name = s.exported.type === "Identifier"
            ? s.exported.name
            : s.exported.value;
          const local = s.local.type === "Identifier"
            ? s.local.name
            : s.local.value;
          return `${JSON.stringify(name)}: ${local}`;
        });
        return replace(node, `__export({ ${exports.join(", ")} })`);
      }
    },
    ExportDefaultDeclaration(node) {
      // `export default x` becomes `__export({ default: x })`
      const name = source.slice(node.declaration.start, node.declaration.end);
      return replace(node, `__export({ default: ${name} })`);
    },
    ExportAllDeclaration(node) {
      // `export * from "module"` becomes `__export(await __import("module"))`
    },
  });
}
