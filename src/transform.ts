import { Parser } from "acorn";
import type { AnyNode, Expression, Identifier, Literal, Pattern } from "acorn";
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
    case "MemberExpression":
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

const root = Symbol("root");
type Scope = Record<string, AnyNode> & { [root]?: Scope };
type Variables = Record<string, string>;

const DEFAULT_VARIABLES = [
  ...Object.getOwnPropertyNames(globalThis),
  "require",
  "__dirname",
  "__filename",
  "module",
  "exports",
];

export type CompileOptions = {
  completion?: boolean;
};

export function compile(
  source: string,
  id: string,
  variables: Variables = {},
  options: CompileOptions = {},
) {
  source = stripTypeScriptTypes(source);

  const ast = parser.parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
  });

  function val(name: string, node?: { start: number; end: number }) {
    if (node === undefined) return `val("${id}", "${name}")`;
    return `val("${id}", "${name}", ${source.slice(node.start, node.end)})`;
  }

  function def(pattern: string, node?: string, scope?: Scope) {
    return ""
  }

  const edits: { start: number; end: number; text: string }[] = [];

  function replace(node: { start: number; end?: number }, text = "") {
    edits.push({ start: node.start, end: node.end ?? node.start, text });
  }

  function slice(node: { start: number; end?: number }) {
    return source.slice(node.start, node.end ?? node.start);
  }

  function create(parent?: Scope, type?: "function"): Scope {
    const scope: Scope = Object.create(parent || null);
    if (type === "function") scope[root] = scope;
    // if (parent) parent[children].children.push(scope);
    return scope;
  }

  function assign(scope: Scope, pattern: Pattern | Pattern[]) {
    return Object.assign(scope, Object.fromEntries(collectNames(pattern)));
  }

  function exists(scope: Scope = {}, name: string) {
    return name in variables || name in DEFAULT_VARIABLES || name in scope;
  }

  (function walk(node: AnyNode, scope?: Scope, ancestors: AnyNode[] = []) {
    switch (node.type) {
      case "FunctionDeclaration":
        if (!scope) {
          if (!node.id) break; // skipped default export function declaration
          def(node.id.name, slice(node));
        } else if (node.id) {
          scope[node.id.name] = node;
        }
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        scope = assign(create(scope, "function"), node.params);
        node = node.body;
        break;
      case "ClassDeclaration":
        if (!scope) {
          if (!node.id) break; // skipped default export class declaration
          def(node.id.name, slice(node));
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
      case "AssignmentExpression":
        // ({ /* scope pattern */ } = def("{ unscoped pattern }", expression));
        throw new Error("AssignmentExpression is not supported yet");
        break;
      case "UpdateExpression":
        if (node.argument.type === "Identifier") {
          const { argument: { name }, operator } = node;
          if (exists(scope, name)) break;
          replace(node, def(name, `${val(name)}${operator[0]}1`, scope));
          return; // Is this correct? Should we return here to avoid further walking?
        }
        break;
      case "VariableDeclaration":
        // toplevel or hoisted to toplevel
        if (!scope || node.kind === "var" && scope[root]) {
          replace(node, "");
          node.declarations.toReversed().forEach(({ id, init }) => {
            const expression = init ? slice(init) : undefined;
            replace({ start: node.start }, def(slice(id), expression));
          });
        } else {
          assign(scope, node.declarations.map(({ id }) => id));
        }
        break;
      case "Identifier":
        if (!isVariableReference(node, ancestors)) break;
        if (node.name in variables) {
          replace(node, variables[node.name]);
          break;
        }
        if (exists(scope, node.name)) break;
        replace(node, val(node.name));
        break;
      case "ImportDeclaration": {
        const { source } = node;
        replace(node, `await __import("${id}", "${source.value}")`);
        node.specifiers.forEach((specifier) => {
          const name = specifier.local.name;
          if (specifier.type === "ImportSpecifier") {
            variables[name] = val(nameof(specifier.imported), source);
          } else if (specifier.type === "ImportDefaultSpecifier") {
            variables[name] = val("default", source);
          } else if (specifier.type === "ImportNamespaceSpecifier") {
            variables[name] = val("*", source);
          }
        });
        break;
      }
      case "ImportExpression":
        replace({ start: node.start }, "__");
        return;
    }
    // @ts-expect-error base is a recursive walker
    base[node.type](node, null, (n) => walk(n, scope, [node, ...ancestors]));
  })(ast);

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
