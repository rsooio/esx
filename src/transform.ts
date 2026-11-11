import { Parser } from "acorn";
import type { AnyNode, Identifier, Literal, Pattern } from "acorn";
import { base } from "acorn-walk";

function nameof(specifier: { name?: string; value?: Literal["value"] }) {
  return specifier.name ?? JSON.stringify(specifier.value);
}

export function isVariableReference(node: Identifier, ancestors: AnyNode[]) {
  const [parent] = ancestors;
  switch (parent?.type) {
    case "MemberExpression":
      return parent.object === node || parent.computed;
    case "Property":
      return parent.value === node || parent.computed || parent.shorthand;
    case "CallExpression":
    case "NewExpression":
      return parent.callee === node || parent.arguments.includes(node);
    case "VariableDeclarator":
      return parent.init === node;
    case "MethodDefinition":
    case "PropertyDefinition":
      return parent.key === node && parent.computed;
    case "ObjectPattern":
      return ancestors[1]?.type === "AssignmentExpression";
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

export function collectNames(pattern: Pattern | Pattern[]): [string, AnyNode][] {
  if (Array.isArray(pattern)) return pattern.flatMap(collectNames);
  switch (pattern.type) {
    case "Identifier":
      return [[pattern.name, pattern]];
    case "ObjectPattern":
      return pattern.properties.flatMap((prop) =>
        collectNames(prop.type === "Property" ? prop.value : prop.argument));
    case "ArrayPattern":
      return pattern.elements.flatMap((element) =>
        element ? collectNames(element) : []);
    case "RestElement":
      return collectNames(pattern.argument);
    case "AssignmentPattern":
      return collectNames(pattern.left);
    case "MemberExpression":
      return [];
  }
}

export const parser = Parser.extend((BaseParser) => class extends BaseParser {
  raiseRecoverable(pos: number, message: string) {
    if (/^Export '.*' is not defined$/.test(message)) return;
    // @ts-expect-error override
    return super.raiseRecoverable(pos, message);
  }
});

const info = Symbol("info");

type ScopeInfo = {
  children: Scope[];
  type: "block" | "function" | "global";
};

type Scope = Record<string, AnyNode> & { [info]: ScopeInfo };
type Variables = Record<string, string>;

const DEFAULT_VARIABLES = Object.getOwnPropertyNames(globalThis);

export function compile(source: string, id: string, variables: Variables = {}) {
  const ast = parser.parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
  });

  function val(name: string, node?: { start: number; end: number }) {
    if (node === undefined) return `val("${id}", "${name}")`;
    return `val("${id}", "${name}", ${source.slice(node.start, node.end)})`;
  }

  function def(name: string, { start, end }: { start: number; end: number }) {
    return `def("${id}", "${name}", ${source.slice(start, end)})`;
  }

  const edits: { start: number; end: number; text: string }[] = [];

  function replace(node: { start: number; end?: number }, text = "") {
    edits.push({ start: node.start, end: node.end ?? node.start, text });
  }

  function assign(scope: Scope, pattern: Pattern | Pattern[], hoist = false) {
    if (hoist && scope[info].type === "block") {
      return assign(Object.getPrototypeOf(scope), pattern, hoist);
    }
    return Object.assign(scope, Object.fromEntries(collectNames(pattern)));
  }

  function create(type: ScopeInfo["type"], parent?: Scope): Scope {
    const scope: Scope = Object.create(parent || null);
    scope[info] = { type, children: [] };
    if (parent) parent[info].children.push(scope);
    return scope;
  }

  function walk(node: AnyNode, scope: Scope, ancestors: AnyNode[] = []) {
    switch (node.type) {
      case "FunctionDeclaration":
        if (node.id) {
          scope[node.id.name] = node;
          if (ancestors.length === 1) replace(node, def(node.id.name, node));
        }
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        scope = assign(create("function", scope), node.params);
        node = node.body;
        break;
      case "ClassDeclaration":
        if (node.id) scope[node.id.name] = node;
      case "ClassExpression":
        node = node.body;
        break;
      case "SwitchStatement":
      case "BlockStatement":
        scope = create("block", scope);
        break;
      case "VariableDeclaration":
        const patterns = node.declarations.map((decl) => decl.id);
        scope = assign(scope, patterns, node.kind === "var");
        if (ancestors.length === 1) {
          replace(node, "");
          // replace({ ...node, end: node.start + node.kind.length }, "");
          node.declarations.forEach((decl) => {
            if (decl.id.type === "Identifier") {
              if (decl.init) {
                replace({ start: node.start }, def(decl.id.name, decl.init));
              }
            }
            // TODO: handle destructuring
          });
        }
        break;
      case "Identifier":
        if (!isVariableReference(node, ancestors)) break;
        if (node.name in variables) {
          replace(node, variables[node.name]);
          break;
        }
        if (DEFAULT_VARIABLES.includes(node.name)) break;
        if (node.name in scope) break;
        replace(node, val(node.name));
        break;
      case "ImportDeclaration":
        const { source } = node;
        replace(node, `await __import("${id}", "${source.value}")`);
        node.specifiers.forEach((s) => {
          if (s.type === "ImportSpecifier") {
            variables[s.local.name] = val(nameof(s.imported), source);
          } else if (s.type === "ImportDefaultSpecifier") {
            variables[s.local.name] = val("default", source);
          } else if (s.type === "ImportNamespaceSpecifier") {
            variables[s.local.name] = val("*", source);
          }
        });
        break;
    }
    // @ts-expect-error base is a recursive walker
    base[node.type](node, null, (n) => walk(n, scope, [node, ...ancestors]));
  }

  const scope = create("global");
  walk(ast, scope);

  edits.sort((a, b) => b.start - a.start);
  edits.forEach(({ start, end, text }) => {
    source = source.slice(0, start) + text + source.slice(end);
  });

  return { scope, code: source };
}
