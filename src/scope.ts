import type { AnyNode, Identifier } from "acorn";
import { parser } from "./transform.ts";
import { base } from "acorn-walk";

function isPatternBinding(ancestors: AnyNode[]) {
  for (const ancestor of ancestors) {
    switch (ancestor.type) {
      case "ObjectPattern":
      case "ArrayPattern":
      case "Property":
      case "RestElement":
      case "AssignmentPattern":
        continue;
      case "VariableDeclarator":
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
      case "CatchClause":
        return true;
      default:
        return false;
    }
  }
  return false;
}

export function isVariableReference(node: Identifier, ancestors: AnyNode[]) {
  const [parent] = ancestors;
  switch (parent?.type) {
    case "MemberExpression": // (...).node or node[...]
      return parent.object === node || parent.computed;
    case "Property":
      if (parent.key === node) return parent.computed;
      // `{a}` in a pattern is a binding; `({a} = x)` is a reference.
      return !isPatternBinding(ancestors.slice(1));
    case "ArrayPattern":
    case "RestElement":
      return !isPatternBinding(ancestors.slice(1));
    case "AssignmentPattern":
      return parent.right === node;
    case "AssignmentExpression":
      return parent.right === node;
    case "UpdateExpression":
      return false;
    case "CatchClause":
      return false;
    case "CallExpression":
    case "NewExpression":
      return parent.callee === node || parent.arguments.includes(node);
    case "VariableDeclarator":
      return parent.init === node;
    case "MethodDefinition":
    case "PropertyDefinition":
      return parent.key === node && parent.computed;
    case "ObjectPattern":
      return !isPatternBinding(ancestors.slice(1));
    case "FunctionDeclaration": // skipped because it is handled in walk()
    case "ClassDeclaration":    // skipped because it is handled in walk()
    case "LabeledStatement":
    case "BreakStatement":
    case "ContinueStatement":
    case "SwitchCase":
      return false;
    default:
      return true;
  }
}

export function transpile(source: string) {
  const ast = parser.parse(source, {
    sourceType: "module",
    ecmaVersion: "latest",
    allowAwaitOutsideFunction: true,
  });

  const edits: { index: number; length: number; text: string }[] = [];

  function replace(index: number, length: number, text = "") {
    edits.push({ index, length, text });
  }

  function debug(node: AnyNode) {
    const code = source.slice(node.start, node.end);
    console.log("```" + node.type + "\n" + code + "\n```");
  }

  (function walk(node: AnyNode, ancestors: AnyNode[] = []) {
    debug(node);
    switch (node.type) {
      case "FunctionDeclaration":
        replace(node.start, 0, `scope.${node.id?.name ?? "default"} = `);
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        node = node.body;
        replace(node.start + 1, 0, "const scope = Object.create(scope);");
        if (node.type !== "BlockStatement") {
          replace(node.start + 1, 0, "{ return ");
          replace(node.end, 0, "}");
        }
        break;
      case "ClassDeclaration":
        replace(node.start, 0, `scope.${node.id?.name ?? "default"} = `);
      case "ClassExpression":
        node = node.body;
        break;
      case "BlockStatement":
        replace(node.start + 1, 0, "const scope = Object.create(scope);");
        break;
      case "CatchClause":
        node = node.body;
        break;
      case "VariableDeclaration":
        replace(node.start, node.kind.length, "(");
        replace(node.end, 0, ")");
        break;
      case "Identifier":
        if (isVariableReference(node, ancestors)) {
          replace(node.start, node.end - node.start, `scope.${node.name}`);
        }
        break;
      case "ImportDeclaration": // TODO: handle attributes
        // const module_xxx = await __import("${file}", ${slice(node.source)})
        // Object.defineProperties(scope, {
        //  "default": { value: module_xxx.default },
        //  "named": { value: module_xxx.named },
        // });
        break;
      case "ImportExpression": // TODO: handle options
        // await __import("${file}", ${slice(node.source)})
        return;
    }
    // @ts-expect-error base is a recursive walker
    base[node.type](node, null, (n) => walk(n, [node, ...ancestors]));
  })(ast);

  edits.sort((a, b) => b.index - a.index);
  for (const { index, length, text } of edits) {
    source = source.slice(0, index) + text + source.slice(index + length);
  }
  return source;
}
