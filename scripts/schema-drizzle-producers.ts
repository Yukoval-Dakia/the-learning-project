/** Bounded syntax evidence, not type-based or whole-program reachability analysis. */
import { dirname, posix } from 'node:path';
import ts from 'typescript';
import type { WriteStatement } from './audit-schema-writes';

type FunctionNode = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;
type Binding = { node: ts.Expression | undefined; env: Environment };
type Environment = ReadonlyMap<ts.ParameterDeclaration, Binding>;
const EMPTY_ENV: Environment = new Map();

function isFunction(node: ts.Node): node is FunctionNode {
  return (
    ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
  );
}
function owner(node: ts.Node): FunctionNode | ts.SourceFile {
  let current = node.parent;
  while (current && !isFunction(current) && !ts.isSourceFile(current)) current = current.parent;
  return current as FunctionNode | ts.SourceFile;
}
function unwrap(node: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAwaitExpression(node)
  )
    node = node.expression;
  return node;
}
function nameOf(node: ts.PropertyName): string | undefined {
  return ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)
    ? node.text
    : undefined;
}

/** Only provided production sources can supply declarations or caller evidence. */
export function extractDrizzleWriteIndex(
  sources: ReadonlyMap<string, string>,
  explicitPayloadTables: ReadonlySet<string> = new Set(),
): Map<string, WriteStatement[]> {
  const files = new Map(
    [...sources].map(([path, source]) => [
      posix.resolve('/', path),
      ts.createSourceFile(
        posix.resolve('/', path),
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      ),
    ]),
  );
  const host: ts.CompilerHost = {
    getSourceFile: (path) => files.get(posix.resolve('/', path)),
    getDefaultLibFileName: () => '',
    writeFile: () => {},
    getCurrentDirectory: () => '/',
    getDirectories: () => [],
    fileExists: (path) => files.has(posix.resolve('/', path)),
    readFile: (path) => files.get(posix.resolve('/', path))?.text,
    getCanonicalFileName: (path) => path,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    resolveModuleNames: (names, containingFile) =>
      names.map((name) => {
        const sourceRoot = containingFile.includes('/src/')
          ? `${containingFile.split('/src/')[0]}/src/`
          : 'src/';
        const prefix = name.startsWith('@/')
          ? sourceRoot + name.slice(2)
          : name.startsWith('.')
            ? posix.join(dirname(containingFile), name)
            : undefined;
        if (!prefix) return undefined;
        const path = [prefix, `${prefix}.ts`, `${prefix}.tsx`, `${prefix}/index.ts`].find(
          (candidate) => files.has(candidate),
        );
        return path ? { resolvedFileName: path } : undefined;
      }),
  };
  const program = ts.createProgram(
    [...files.keys()],
    { noLib: true, noResolve: false, target: ts.ScriptTarget.Latest },
    host,
  );
  const checker = program.getTypeChecker();
  const symbol = (node: ts.Node): ts.Symbol | undefined => {
    const shorthand = ts.isShorthandPropertyAssignment(node)
      ? node
      : ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent)
        ? node.parent
        : undefined;
    const found = shorthand
      ? checker.getShorthandAssignmentValueSymbol(shorthand)
      : checker.getSymbolAtLocation(node);
    return found && found.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(found) : found;
  };
  const declaration = (node: ts.Node): ts.Declaration | undefined =>
    symbol(node)?.valueDeclaration ?? symbol(node)?.declarations?.[0];
  const reassigned = new Set<ts.Declaration>();
  const mutated = new Set<ts.Declaration>();
  function callable(node: ts.Expression, seen = new Set<ts.Node>()): FunctionNode | undefined {
    node = unwrap(node);
    if (seen.has(node)) return undefined;
    seen.add(node);
    if (isFunction(node)) return node;
    const decl = declaration(node);
    if (decl && reassigned.has(decl)) return undefined;
    if (decl && isFunction(decl)) return decl;
    return decl && ts.isVariableDeclaration(decl) && decl.initializer
      ? callable(decl.initializer, seen)
      : undefined;
  }
  const calls: ts.CallExpression[] = [];
  const callsTo = new Map<FunctionNode, ts.CallExpression[]>();
  const pushes = new Map<ts.Declaration, ts.CallExpression[]>();
  function recordMutation(input: ts.Expression): void {
    let node = unwrap(input);
    const wholeBinding = ts.isIdentifier(node);
    while (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      node = unwrap(node.expression);
    }
    const decl = ts.isIdentifier(node) ? declaration(node) : undefined;
    if (decl) (wholeBinding ? reassigned : mutated).add(decl);
  }
  for (const file of files.values()) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        recordMutation(node.left);
      }
      if (ts.isDeleteExpression(node)) recordMutation(node.expression);
      if (ts.isCallExpression(node)) {
        calls.push(node);
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'push'
        ) {
          const decl = declaration(node.expression.expression);
          if (decl) pushes.set(decl, [...(pushes.get(decl) ?? []), node]);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  // Resolve calls only after collecting mutations from every file. A later
  // reassignment must not leave an earlier call bound to a stale initializer.
  for (const call of calls) {
    const fn = callable(call.expression);
    if (fn) callsTo.set(fn, [...(callsTo.get(fn) ?? []), call]);
  }
  function invokedWithin(
    fn: FunctionNode | ts.SourceFile,
    scope: FunctionNode | ts.SourceFile,
    seen = new Set<ts.Node>(),
  ): boolean {
    if (fn === scope) return true;
    if (ts.isSourceFile(fn) || seen.has(fn)) return false;
    seen.add(fn);
    return (callsTo.get(fn) ?? []).some((call) => invokedWithin(owner(call), scope, new Set(seen)));
  }
  function returns(fn: FunctionNode): ts.Expression[] {
    if (!fn.body) return [];
    if (!ts.isBlock(fn.body)) return [fn.body];
    const result: ts.Expression[] = [];
    const visit = (node: ts.Node): void => {
      if (isFunction(node)) return;
      if (ts.isReturnStatement(node) && node.expression) result.push(node.expression);
      ts.forEachChild(node, visit);
    };
    visit(fn.body);
    return result;
  }
  function bindings(
    fn: FunctionNode,
    args: readonly ts.Expression[],
    env: Environment,
  ): Environment {
    const next = new Map(env);
    fn.parameters.forEach((parameter, index) => {
      const arg = args[index];
      // A missing argument is an explicit unknown, never an unbound parameter
      // whose evidence may be borrowed from a different call.
      next.set(parameter, {
        node: arg ?? parameter.initializer,
        env: arg ? env : new Map(next),
      });
    });
    return next;
  }
  // Each query has a finite budget and an expression path guard; unresolved
  // calls/types are opaque, never a license to borrow their argument fields.
  function columns(input: ts.Expression, property?: string): Set<string> {
    let remaining = 4000;
    const resolve = (
      input: ts.Expression,
      env: Environment,
      path: Set<ts.Node>,
      property?: string,
    ): Set<string> => {
      const node = unwrap(input);
      if (--remaining < 0 || path.size > 40 || path.has(node)) return new Set();
      const nextPath = new Set(path).add(node);
      const out = new Set<string>();
      const add = (expression: ts.Expression, context = env, key = property) => {
        for (const field of resolve(expression, context, nextPath, key)) out.add(field);
      };
      if (ts.isObjectLiteralExpression(node)) {
        if (property !== undefined) {
          // JavaScript object construction is last-write-wins. A later opaque
          // spread may override the property, so it also ends the proof.
          for (const entry of [...node.properties].reverse()) {
            if (ts.isSpreadAssignment(entry)) {
              add(entry.expression);
              return out;
            }
            if (
              (ts.isPropertyAssignment(entry) || ts.isShorthandPropertyAssignment(entry)) &&
              nameOf(entry.name) === property
            ) {
              return resolve(
                ts.isPropertyAssignment(entry) ? entry.initializer : entry.name,
                env,
                nextPath,
              );
            }
          }
          return out;
        }
        for (const entry of node.properties) {
          if (ts.isSpreadAssignment(entry)) add(entry.expression);
          else if (ts.isPropertyAssignment(entry) || ts.isShorthandPropertyAssignment(entry)) {
            const key = nameOf(entry.name);
            if (key !== undefined) out.add(key);
          }
        }
      } else if (ts.isArrayLiteralExpression(node)) {
        for (const entry of node.elements)
          if (!ts.isOmittedExpression(entry))
            add(ts.isSpreadElement(entry) ? entry.expression : entry);
      } else if (ts.isIdentifier(node)) {
        const decl = declaration(node);
        // Reassigned containers require control-flow analysis, outside this
        // bounded construction proof. Never count their stale initializer.
        if (decl && (reassigned.has(decl) || mutated.has(decl))) return out;
        if (decl && ts.isVariableDeclaration(decl)) {
          if (decl.initializer) add(decl.initializer);
          for (const push of pushes.get(decl) ?? []) {
            if (invokedWithin(owner(push), owner(decl))) for (const arg of push.arguments) add(arg);
          }
        } else if (decl && ts.isParameter(decl)) {
          const bound = env.get(decl);
          if (bound) {
            if (bound.node) add(bound.node, bound.env);
          } else if (isFunction(decl.parent)) {
            const fn = decl.parent;
            const position = fn.parameters.indexOf(decl);
            for (const call of callsTo.get(fn) ?? []) {
              const arg = call.arguments[position];
              if (arg) add(arg);
            }
            if (decl.initializer) add(decl.initializer);
          }
        }
      } else if (ts.isConditionalExpression(node)) {
        add(node.whenTrue);
        add(node.whenFalse);
      } else if (
        ts.isBinaryExpression(node) &&
        [
          ts.SyntaxKind.QuestionQuestionToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.AmpersandAmpersandToken,
        ].includes(node.operatorToken.kind)
      ) {
        add(node.left);
        add(node.right);
      } else if (ts.isPropertyAccessExpression(node) && property === undefined) {
        for (const field of resolve(node.expression, env, nextPath, node.name.text)) out.add(field);
      } else if (ts.isCallExpression(node)) {
        const fn = callable(node.expression);
        if (fn) {
          const context = bindings(fn, node.arguments, env);
          for (const result of returns(fn)) add(result, context);
        } else if (ts.isPropertyAccessExpression(node.expression)) {
          // A declared own method is not evidence of native array behavior.
          if (declaration(node.expression)) return out;
          const method = node.expression.name.text;
          if (method === 'map' || method === 'flatMap') {
            const callback = node.arguments[0] && callable(node.arguments[0]);
            if (callback) {
              const context = bindings(callback, [node.expression.expression], env);
              for (const result of returns(callback)) add(result, context);
            }
          } else if (method === 'filter' || method === 'slice') add(node.expression.expression);
        }
      }
      return out;
    };
    return resolve(input, EMPTY_ENV, new Set(), property);
  }
  function tableName(arg: ts.Expression, seen = new Set<ts.Node>()): string | undefined {
    arg = unwrap(arg);
    if (!ts.isIdentifier(arg) || seen.has(arg)) return undefined;
    seen.add(arg);
    // The schema file is intentionally excluded as runtime evidence. Preserve
    // an import's original table identity even when its declaration is opaque.
    const imported = checker.getSymbolAtLocation(arg)?.declarations?.find(ts.isImportSpecifier);
    if (imported) return (imported.propertyName ?? imported.name).text;
    const decl = declaration(arg);
    if (decl && (reassigned.has(decl) || ts.isParameter(decl))) return undefined;
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      const value = unwrap(decl.initializer);
      if (ts.isIdentifier(value)) return tableName(value, seen);
      if (
        ts.isCallExpression(value) &&
        ts.isIdentifier(value.expression) &&
        value.expression.text === 'pgTable'
      ) {
        const name = value.arguments[0];
        return name && ts.isStringLiteral(name) ? name.text : undefined;
      }
      return undefined;
    }
    return arg.text;
  }
  function target(input: ts.Expression, operation: 'insert' | 'update'): string | undefined {
    let node = unwrap(input);
    while (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      if (node.expression.name.text === operation) {
        const arg = node.arguments[0];
        return arg ? tableName(arg) : undefined;
      }
      node = unwrap(node.expression.expression);
    }
    return undefined;
  }
  const sourcePaths = new Map([...sources.keys()].map((path) => [posix.resolve('/', path), path]));
  function literalStrings(expression: ts.Expression): string[] | undefined {
    const type = checker.getTypeAtLocation(expression);
    const values: string[] = [];
    for (const member of type.isUnion() ? type.types : [type]) {
      if (!member.isStringLiteral()) return undefined;
      values.push(member.value);
    }
    return values;
  }
  function dateConstruction(input: ts.Expression, seen = new Set<ts.Node>()): boolean {
    const expression = unwrap(input);
    if (seen.has(expression)) return false;
    seen.add(expression);
    if (ts.isNewExpression(expression))
      return ts.isIdentifier(expression.expression) && expression.expression.text === 'Date';
    if (!ts.isIdentifier(expression)) return false;
    const decl = declaration(expression);
    return Boolean(
      decl &&
        ts.isVariableDeclaration(decl) &&
        decl.initializer &&
        !reassigned.has(decl) &&
        !mutated.has(decl) &&
        dateConstruction(decl.initializer, seen),
    );
  }
  const index = new Map<string, WriteStatement[]>([...sources.keys()].map((path) => [path, []]));
  for (const call of calls) {
    if (!ts.isPropertyAccessExpression(call.expression) || !call.arguments[0]) continue;
    const method = call.expression.name.text;
    const kind = method === 'values' ? 'insert' : 'update';
    if (method !== 'values' && method !== 'set' && method !== 'onConflictDoUpdate') continue;
    const table = target(call.expression.expression, method === 'set' ? 'update' : 'insert');
    if (!table) continue;
    const fields = columns(call.arguments[0], method === 'onConflictDoUpdate' ? 'set' : undefined);
    // Preserve the table target even when bounded payload tracing is opaque.
    // It supplies no field evidence, but historical tables forbid every write.
    let payload = `{${[...fields].map((field) => `${JSON.stringify(field)}: true`).join(',')}}`;
    const arg = unwrap(call.arguments[0]);
    // Preserve inspectable literal evidence for callers; field matching still
    // reads only its top-level AST keys, never nested values/comments/strings.
    const explicitPayload =
      method !== 'onConflictDoUpdate' &&
      ts.isObjectLiteralExpression(arg) &&
      !arg.properties.some(ts.isSpreadAssignment);
    if (explicitPayload) payload = arg.getText();
    const status =
      explicitPayloadTables.has(table) && explicitPayload && ts.isObjectLiteralExpression(arg)
        ? arg.properties.find(
            (property) =>
              (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
              nameOf(property.name) === 'status',
          )
        : undefined;
    const statusValues =
      status && (ts.isPropertyAssignment(status) || ts.isShorthandPropertyAssignment(status))
        ? literalStrings(ts.isPropertyAssignment(status) ? status.initializer : status.name)
        : undefined;
    const started =
      explicitPayloadTables.has(table) && explicitPayload && ts.isObjectLiteralExpression(arg)
        ? arg.properties.find(
            (property) =>
              (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
              nameOf(property.name) === 'started_at',
          )
        : undefined;
    const nativeStartedAt =
      started && (ts.isPropertyAssignment(started) || ts.isShorthandPropertyAssignment(started))
        ? dateConstruction(ts.isPropertyAssignment(started) ? started.initializer : started.name)
        : false;
    index.get(sourcePaths.get(call.getSourceFile().fileName) ?? '')?.push({
      kind,
      table,
      payload,
      ...(explicitPayloadTables.has(table)
        ? { explicitPayload, nativeStartedAt, ...(statusValues ? { statusValues } : {}) }
        : {}),
    });
  }
  return index;
}

export function payloadColumns(payload: string): Set<string> {
  const file = ts.createSourceFile(
    'payload.ts',
    `const value = ${payload}`,
    ts.ScriptTarget.Latest,
    true,
  );
  const statement = file.statements[0];
  if (!statement || !ts.isVariableStatement(statement)) return new Set();
  const value = statement.declarationList.declarations[0]?.initializer;
  if (!value || !ts.isObjectLiteralExpression(value)) return new Set();
  return new Set(
    value.properties.flatMap((entry) => {
      const name =
        ts.isPropertyAssignment(entry) || ts.isShorthandPropertyAssignment(entry)
          ? nameOf(entry.name)
          : undefined;
      return name === undefined ? [] : [name];
    }),
  );
}
