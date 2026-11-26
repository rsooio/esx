import { Parser } from "acorn";
import type { AnyNode, Identifier, Literal, Pattern } from "acorn";
import { base } from "acorn-walk";
import { stripTypeScriptTypes } from "node:module";

function nameof(specifier: { name?: string; value?: Literal["value"] }) {
  return specifier.name ?? JSON.stringify(specifier.value);
}

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

const INFO = Symbol("INFO");
type ScopeType = "global" | "module" | "function" | "block";
type Scope = {
  [INFO]: { type: ScopeType; top: Scope; id: string };
  [name: string]: any;
};
type Variables = Record<string, string>;

export type CompileOptions = {
  completion?: boolean;
};

export function compile(
  source: string,
  file: string,
  variables: Variables = {},
  options: CompileOptions = {},
) {
  source = stripTypeScriptTypes(source);

  const ast = parser.parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
  });

  function val(name: string, source = "undefined") {
    if (variables[name]) return variables[name];
    return `val("${file}", "${name}", ${source}).value`;
  }

  function def(name: string, expression: string, exported = false) {
    return `def("${file}", "${name}", ${exported}).value = ${expression};`;
  }

  const edits: { start: number; end: number; text: string }[] = [];

  function replace(node: { start: number; end?: number }, text = "") {
    edits.push({ start: node.start, end: node.end ?? node.start, text });
  }

  function slice(node: { start: number; end?: number }) {
    return source.slice(node.start, node.end ?? node.start);
  }

  function create(type: ScopeType, parent?: Scope): Scope {
    const scope: Scope = Object.create(parent || null);
    const top = type === "block" ? parent![INFO].top : scope;
    scope[INFO] = { type, top, id: crypto.randomUUID() };
    return scope;
  }

  function assign(scope: Scope, pattern: Pattern | Pattern[]) {
    return Object.assign(scope, Object.fromEntries(collectNames(pattern)));
  }

  (function walk(node: AnyNode, scope: Scope, ancestors: AnyNode[] = []) {
    const topLevel = scope[INFO].type === "module";
    switch (node.type) {
      case "FunctionDeclaration":
        if (!scope) {
          replace(node, def(node.id?.name ?? "default", slice(node)));
        } else if (node.id) {
          scope[node.id.name] = node;
        }
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        scope = assign(create("function", scope), node.params);
        node = node.body;
        break;
      case "ClassDeclaration":
        if (!scope) {
          replace(node, def(node.id?.name ?? "default", slice(node)));
        } else if (node.id) {
          scope[node.id.name] = node;
        }
      case "ClassExpression":
        scope = create(scope);
        scope["this"] = node;
        node = node.body;
        break;
      case "SwitchStatement":
      case "BlockStatement":
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement":
        scope = create(scope);
        break;
      case "CatchClause":
        scope = assign(create(scope), node.param ? [node.param] : []);
        node = node.body;
        break;
      case "VariableDeclaration":
        // toplevel or hoisted to toplevel
        if (!scope || node.kind === "var" && scope[info]) {
          replace(node, "");
          node.declarations.toReversed().forEach(({ id, init }) => {
            if (!init) return;
            replace({ start: node.start }, def(slice(id), slice(init)));
          });
        } else {
          assign(scope, node.declarations.map(({ id }) => id));
        }
        break;
      case "Identifier":
        if (isVariableReference(node, ancestors) && !scope?.[node.name]) {
          replace(node, val(node.name));
        }
        break;
      case "ImportDeclaration": // TODO: handle attributes
        replace(node, `await __import("${file}", ${slice(node.source)})`);
        for (const specifier of node.specifiers) {
          const name = (() => {
            if (specifier.type === "ImportDefaultSpecifier") return "default";
            if (specifier.type === "ImportNamespaceSpecifier") return "*";
            return nameof(specifier.imported);
          })();
          variables[specifier.local.name] = val(name, slice(node.source));
        }
        break;
      case "ImportExpression": // TODO: handle options
        replace(node, `await __import("${file}", ${slice(node.source)})`);
        return;
    }
    // @ts-expect-error base is a recursive walker
    base[node.type](node, null, (n) => walk(n, scope, [node, ...ancestors]));
  })(ast, create("module"));

  if (options.completion) {
    const node = ast.body.findLast(({ type }) => type === "ExpressionStatement");
    if (node) replace({ start: node.start }, "return ");
  }

  edits.sort((a, b) => b.start - a.start);
  edits.forEach(({ start, end, text }) => {
    source = source.slice(0, start) + text + source.slice(end);
  });

  return source;
}

export class Transpiler {
  private readonly global: Variables;
  private readonly variables = new Map<string, Variables>();

  constructor(global: string[] = []) {
    this.global = Object.fromEntries(global.map((name) => [name, name]));
  }

  transpile(source: string, file: string, completion = false) {
    const variables = this.variables.get(file) ?? { ...this.global };
    if (!this.variables.has(file)) this.variables.set(file, variables);
    return compile(source, file, variables, { completion });
  }
}
