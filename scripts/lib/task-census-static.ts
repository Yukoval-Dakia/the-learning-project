import ts from 'typescript';

const RUNNER_NAMES = new Set([
  'runTask',
  'runAgentTask',
  'streamTask',
  'streamTaskCollecting',
  'runTaskFn',
  'runAgentTaskFn',
]);
const RUNNER_FACTORY_NAMES = new Set([
  'defaultRunTaskFn',
  'defaultStructuredRunTaskFn',
  'judgeDefaultRunTaskFn',
  'makeDefaultRunTaskFn',
  'makeRunTaskFn',
  'makeRunTaskTextFn',
]);

function expressionName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  return ts.isPropertyAccessExpression(expression) ? expression.name.text : undefined;
}

function isRunnerName(name: string, aliases: ReadonlySet<string>): boolean {
  return (
    RUNNER_NAMES.has(name) || aliases.has(name) || /run(?:Agent)?Task(?:Fn|Inner)$/i.test(name)
  );
}

function expressionProvidesRunner(
  expression: ts.Expression,
  aliases: ReadonlySet<string>,
): boolean {
  if (ts.isParenthesizedExpression(expression) || ts.isAwaitExpression(expression)) {
    return expressionProvidesRunner(expression.expression, aliases);
  }
  if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) {
    const name = expressionName(expression);
    return name !== undefined && isRunnerName(name, aliases);
  }
  if (ts.isCallExpression(expression)) {
    const name = expressionName(expression.expression);
    return name !== undefined && RUNNER_FACTORY_NAMES.has(name);
  }
  if (ts.isConditionalExpression(expression)) {
    return (
      expressionProvidesRunner(expression.whenTrue, aliases) ||
      expressionProvidesRunner(expression.whenFalse, aliases)
    );
  }
  return (
    ts.isBinaryExpression(expression) &&
    (expressionProvidesRunner(expression.left, aliases) ||
      expressionProvidesRunner(expression.right, aliases))
  );
}

export function collectRunnerAliases(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const aliases = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined &&
        !aliases.has(node.name.text) &&
        expressionProvidesRunner(node.initializer, aliases)
      ) {
        aliases.add(node.name.text);
        changed = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return aliases;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isTypeAssertionExpression(expression)
  ) {
    return unwrapExpression(expression.expression);
  }
  return expression;
}

function isDelegatedParameter(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  const unwrapped = unwrapExpression(expression);
  if (!ts.isIdentifier(unwrapped)) {
    return false;
  }
  const declaration = checker.getSymbolAtLocation(unwrapped)?.valueDeclaration;
  return declaration !== undefined && ts.isParameter(declaration);
}

function functionLikeName(node: ts.SignatureDeclaration): string | undefined {
  if ('name' in node && node.name !== undefined && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  return ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)
    ? node.parent.name.text
    : undefined;
}

function isInsideRunnerAdapter(node: ts.Node, aliases: ReadonlySet<string>): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isFunctionLike(current)) {
      const name = functionLikeName(current);
      if (name !== undefined && (RUNNER_FACTORY_NAMES.has(name) || isRunnerName(name, aliases))) {
        return true;
      }
    }
    current = current.parent;
  }
  return false;
}

export function isRunnerInfrastructureDelegation(
  relativePath: string,
  expression: ts.Expression,
  checker: ts.TypeChecker,
  aliases: ReadonlySet<string>,
): boolean {
  if (!isDelegatedParameter(expression, checker)) {
    return false;
  }
  return (
    relativePath === 'src/server/ai/runner.ts' ||
    relativePath === 'src/server/ai/runner-fn.ts' ||
    isInsideRunnerAdapter(expression, aliases)
  );
}

function stringLiteralsFromType(type: ts.Type): readonly string[] | undefined {
  if (type.isStringLiteral()) {
    return [type.value];
  }
  if (!type.isUnion()) {
    return undefined;
  }
  const values = type.types.flatMap((member) => stringLiteralsFromType(member) ?? []);
  return values.length === type.types.length ? [...new Set(values)].sort() : undefined;
}

export function resolveTaskKinds(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seenSymbols: ReadonlySet<ts.Symbol> = new Set(),
): readonly string[] | undefined {
  const unwrapped = unwrapExpression(expression);
  if (ts.isStringLiteralLike(unwrapped)) {
    return [unwrapped.text];
  }
  if (ts.isConditionalExpression(unwrapped)) {
    const whenTrue = resolveTaskKinds(unwrapped.whenTrue, checker, seenSymbols);
    const whenFalse = resolveTaskKinds(unwrapped.whenFalse, checker, seenSymbols);
    return whenTrue === undefined || whenFalse === undefined
      ? undefined
      : [...new Set([...whenTrue, ...whenFalse])].sort();
  }
  if (
    ts.isBinaryExpression(unwrapped) &&
    (unwrapped.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      unwrapped.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    const left = resolveTaskKinds(unwrapped.left, checker, seenSymbols);
    const right = resolveTaskKinds(unwrapped.right, checker, seenSymbols);
    return left === undefined || right === undefined
      ? undefined
      : [...new Set([...left, ...right])].sort();
  }
  if (!ts.isIdentifier(unwrapped)) {
    return undefined;
  }
  const typeKinds = stringLiteralsFromType(checker.getTypeAtLocation(unwrapped));
  if (typeKinds !== undefined) {
    return typeKinds;
  }
  const symbol = checker.getSymbolAtLocation(unwrapped);
  if (symbol === undefined || seenSymbols.has(symbol)) {
    return undefined;
  }
  const declaration = symbol.valueDeclaration;
  if (
    declaration === undefined ||
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer === undefined ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return undefined;
  }
  return resolveTaskKinds(declaration.initializer, checker, new Set([...seenSymbols, symbol]));
}

export function isRunnerCall(call: ts.CallExpression, aliases: ReadonlySet<string>): boolean {
  if (call.arguments.length < 2) {
    return false;
  }
  const name = expressionName(call.expression);
  return name !== undefined && !RUNNER_FACTORY_NAMES.has(name) && isRunnerName(name, aliases);
}
