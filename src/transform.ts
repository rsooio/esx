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

const info = Symbol("info");

type ScopeInfo = {
  children: Scope[];
  type: "block" | "function" | "global";
};

type Scope = Record<string, AnyNode> & { [info]: ScopeInfo };
type Variables = Record<string, string>;

const DEFAULT_VARIABLES = [...Object.getOwnPropertyNames(globalThis), "require"];

export function compile(source: string, id: string, variables: Variables = {}) {
  source = stripTypeScriptTypes(source);

  const ast = parser.parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
  });

  function val(name: string, node?: { start: number; end: number }) {
    if (node === undefined) return `(val(${JSON.stringify(id)}, ${JSON.stringify(name)}))`;
    return `(val(${JSON.stringify(id)}, ${JSON.stringify(name)}, ${source.slice(node.start, node.end)}))`;
  }

  function def(name: string) {
    return `def(${JSON.stringify(id)}, ${JSON.stringify(name)}, ${name})`;
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

  function findScope(scope: Scope, name: string): Scope | undefined {
    for (let current: Scope | null = scope; current; current = Object.getPrototypeOf(current)) {
      if (Object.prototype.hasOwnProperty.call(current, name)) return current;
    }
    return undefined;
  }

  function joinDefs(names: string[], end: number) {
    const separator = source[end - 1] === ";" ? "" : ";";
    return names
      .map((name, index) => `${index === 0 ? separator : ";"}${def(name)}`)
      .join("") + ";";
  }

  function create(type: ScopeInfo["type"], parent?: Scope): Scope {
    const scope: Scope = Object.create(parent || null);
    scope[info] = { type, children: [] };
    if (parent) parent[info].children.push(scope);
    return scope;
  }

  function walk(
    node: AnyNode,
    scope: Scope,
    ancestors: AnyNode[] = [],
    topLevel = false,
  ) {
    switch (node.type) {
      case "FunctionDeclaration":
        if (node.id) {
          scope[node.id.name] = node;
          if (topLevel) replace({ start: node.end }, `;${def(node.id.name)};`);
        }
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        scope = assign(create("function", scope), node.params);
        node = node.body;
        break;
      case "ClassDeclaration":
        if (node.id) {
          scope[node.id.name] = node;
          if (topLevel) {
            replace({ start: node.start }, `var ${node.id.name} = `);
            replace({ start: node.end }, `;${def(node.id.name)};`);
          }
        }
        node = node.body;
        break;
      case "ClassExpression":
        node = node.body;
        break;
      case "SwitchStatement":
      case "BlockStatement":
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement":
        scope = create("block", scope);
        break;
      case "CatchClause":
        scope = assign(create("block", scope), node.param ? [node.param] : []);
        node = node.body;
        break;
      case "AssignmentExpression":
        if (node.left.type === "Identifier") {
          const owner = findScope(scope, node.left.name);
          if (owner && owner[info].type !== "global") break;
          const name = node.left.name;
          if (node.operator === "=") {
            replace(
              { start: node.start, end: node.right.start },
              `set(${JSON.stringify(id)}, ${JSON.stringify(name)}, `,
            );
          } else {
            const operator = node.operator.slice(0, -1);
            replace(
              { start: node.start, end: node.right.start },
              `set(${JSON.stringify(id)}, ${JSON.stringify(name)}, ${val(name)} ${operator} `,
            );
          }
          replace({ start: node.end }, ");");
          walk(node.right, scope, [node, ...ancestors], false);
          return;
        }
        break;
      case "UpdateExpression":
        if (node.argument.type === "Identifier") {
          const owner = findScope(scope, node.argument.name);
          if (owner && owner[info].type !== "global") break;
          const name = node.argument.name;
          const operator = node.operator === "++" ? "+" : "-";
          replace(
            node,
            `set(${JSON.stringify(id)}, ${JSON.stringify(name)}, ${val(name)} ${operator} 1)`,
          );
          return;
        }
        break;
      case "VariableDeclaration": {
        const patterns = node.declarations.map((decl) => decl.id);
        scope = assign(scope, patterns, node.kind === "var");
        if (topLevel) {
          if (node.kind !== "var") {
            replace(
              { start: node.start, end: node.start + node.kind.length },
              "var",
            );
          }
          const names = patterns.flatMap(collectNames).map(([name]) => name);
          if (names.length) {
            replace({ start: node.end }, joinDefs(names, node.end));
          }
        }
        break;
      }
      case "Identifier":
        if (!isVariableReference(node, ancestors)) break;
        if (node.name in variables) {
          replace(node, variables[node.name]);
          break;
        }
        {
          const owner = findScope(scope, node.name);
          if (owner) {
            if (owner[info].type === "global") replace(node, val(node.name));
            break;
          }
        }
        if (DEFAULT_VARIABLES.includes(node.name)) break;
        replace(node, val(node.name));
        break;
      case "ImportDeclaration": {
        const { source } = node;
        replace(
          node,
          `await __import(${JSON.stringify(id)}, ${JSON.stringify(source.value)});`,
        );
        node.specifiers.forEach((specifier) => {
          if (specifier.type === "ImportSpecifier") {
            variables[specifier.local.name] = val(nameof(specifier.imported), source);
          } else if (specifier.type === "ImportDefaultSpecifier") {
            variables[specifier.local.name] = val("default", source);
          } else if (specifier.type === "ImportNamespaceSpecifier") {
            variables[specifier.local.name] = val("*", source);
          }
        });
        break;
      }
      case "ImportExpression": {
        replace(
          { start: node.start, end: node.source.start },
          `__importDynamic(${JSON.stringify(id)}, `,
        );
        walk(node.source, scope, [node, ...ancestors], false);
        return;
      }
      case "ExportNamedDeclaration":
        if (node.declaration) {
          replace({ start: node.start, end: node.declaration.start });
          walk(node.declaration, scope, [node, ...ancestors], topLevel);
        } else {
          replace(node, ";");
        }
        return;
      case "ExportDefaultDeclaration":
        if (
          node.declaration.type !== "FunctionDeclaration" &&
          node.declaration.type !== "ClassDeclaration"
        ) {
          replace(
            { start: node.start, end: node.declaration.start },
            `def(${JSON.stringify(id)}, "default", `,
          );
          replace({ start: node.end }, ");");
          walk(node.declaration, scope, [node, ...ancestors], false);
        }
        return;
    }
    // @ts-expect-error base is a recursive walker
    base[node.type](node, null, (n) =>
      walk(n, scope, [node, ...ancestors], topLevel && node.type === "Program"));
  }

  const scope = create("global");
  walk(ast, scope, [], true);

  edits.sort((a, b) => b.start - a.start);
  edits.forEach(({ start, end, text }) => {
    source = source.slice(0, start) + text + source.slice(end);
  });

  return { scope, code: source };
}
