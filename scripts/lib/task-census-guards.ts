import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const GUARDED_FILES = [
  'src/ai/task-catalog.ts',
  'src/ai/owned-task-specs.ts',
  'src/capabilities/practice/tasks/index.ts',
  'src/capabilities/notes/tasks/index.ts',
  'src/capabilities/ingestion/tasks/index.ts',
  'src/capabilities/knowledge/tasks/index.ts',
  'src/capabilities/agency/tasks/index.ts',
  'src/capabilities/copilot/tasks/index.ts',
] as const;

const DISCOVERY_MODULES = new Set(['fs', 'node:fs', 'node:fs/promises', 'glob', 'fast-glob']);
const DISCOVERY_CALLS = new Set([
  'readdir',
  'readdirSync',
  'glob',
  'globSync',
  'sync',
  'walk',
  'walkSync',
]);

export interface ForbiddenTaskCatalogPattern {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly reason: string;
}

function expressionName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function location(
  relativeFile: string,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  reason: string,
): ForbiddenTaskCatalogPattern {
  const point = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { file: relativeFile, line: point.line + 1, column: point.character + 1, reason };
}

function isProcessEnv(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node)) {
    return (
      node.name.text === 'env' &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'process'
    );
  }
  return (
    ts.isElementAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'process' &&
    node.argumentExpression !== undefined &&
    ts.isStringLiteralLike(node.argumentExpression) &&
    node.argumentExpression.text === 'env'
  );
}

function hasOwnerPrecedence(node: ts.BinaryExpression, sourceFile: ts.SourceFile): boolean {
  if (
    node.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken &&
    node.operatorToken.kind !== ts.SyntaxKind.BarBarToken
  ) {
    return false;
  }
  const executable = `${node.left.getText(sourceFile)} ${node.right.getText(sourceFile)}`;
  return /owner/i.test(executable) && /(fallback|override)/i.test(executable);
}

function conditionalHasOwnerPrecedence(
  node: ts.ConditionalExpression,
  sourceFile: ts.SourceFile,
): boolean {
  const executable = `${node.condition.getText(sourceFile)} ${node.whenTrue.getText(sourceFile)} ${node.whenFalse.getText(sourceFile)}`;
  return /owner/i.test(executable) && /(fallback|override)/i.test(executable);
}

export function scanForbiddenTaskCatalogPatterns(
  sourceRoot: string,
): readonly ForbiddenTaskCatalogPattern[] {
  const violations: ForbiddenTaskCatalogPattern[] = [];
  for (const relativeFile of GUARDED_FILES) {
    const filePath = path.join(sourceRoot, relativeFile);
    if (!existsSync(filePath)) continue;
    const sourceFile = ts.createSourceFile(
      filePath,
      readFileSync(filePath, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteralLike(node.moduleSpecifier) &&
        DISCOVERY_MODULES.has(node.moduleSpecifier.text)
      ) {
        violations.push(
          location(relativeFile, sourceFile, node, 'filesystem/glob task discovery import'),
        );
      } else if (ts.isCallExpression(node)) {
        const name = expressionName(node.expression);
        if (name === 'registerTask' || name === 'setTask') {
          violations.push(location(relativeFile, sourceFile, node, `mutable ${name} registration`));
        } else if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          violations.push(
            location(relativeFile, sourceFile, node, 'dynamic import task discovery'),
          );
        } else if (name !== undefined && DISCOVERY_CALLS.has(name)) {
          violations.push(
            location(relativeFile, sourceFile, node, 'filesystem/glob task discovery call'),
          );
        } else if (
          name === 'require' &&
          node.arguments[0] !== undefined &&
          ts.isStringLiteralLike(node.arguments[0]) &&
          DISCOVERY_MODULES.has(node.arguments[0].text)
        ) {
          violations.push(
            location(relativeFile, sourceFile, node, 'filesystem/glob task discovery require'),
          );
        }
      } else if (isProcessEnv(node)) {
        violations.push(
          location(relativeFile, sourceFile, node, 'environment-selected task owner'),
        );
      } else if (ts.isBinaryExpression(node) && hasOwnerPrecedence(node, sourceFile)) {
        violations.push(
          location(relativeFile, sourceFile, node, 'fallback owner/override precedence'),
        );
      } else if (
        ts.isConditionalExpression(node) &&
        conditionalHasOwnerPrecedence(node, sourceFile)
      ) {
        violations.push(
          location(relativeFile, sourceFile, node, 'fallback owner/override precedence'),
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return violations;
}
