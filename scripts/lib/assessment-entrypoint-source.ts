import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

import type { EvaluationSourceEvidence } from '../../src/server/release/assessment-manifest';

// Independent acceptance inventory (grounding §4.2), not the runtime registry's lane labels.
export const EXPECTED_GRADING_ENTRIES = [
  'solo_submit',
  'durable_judge_run',
  'paper_submit',
  'solve_tutor',
  'appeal_rejudge',
  'conjecture_probe',
  'ingestion_grading',
  'advice_preview',
] as const;
const AUTHORITY = 'src/capabilities/practice/server/judge/evaluation-authority.ts';

function unwrap(expression: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    expression = expression.expression;
  }
  return expression;
}

function strings(expression: ts.Expression): string[] | null {
  const value = unwrap(expression);
  if (ts.isStringLiteralLike(value)) return [value.text];
  if (ts.isConditionalExpression(value)) {
    const yes = strings(value.whenTrue);
    const no = strings(value.whenFalse);
    return yes && no ? [...new Set([...yes, ...no])] : null;
  }
  return null;
}

/** Bounded syntactic census, not a call-graph or deployed-image proof. Unknown uses stay visible. */
export function inspectAssessmentSources(
  files: Readonly<Record<string, string>>,
): EvaluationSourceEvidence {
  const evidence: EvaluationSourceEvidence = {
    scope: 'checkout-source',
    files: [],
    calls: [],
    legacyExecutor: [],
    unresolved: [],
    missingEntries: [],
  };
  if (!(AUTHORITY in files)) evidence.unresolved.push(`${AUTHORITY}: missing authority source`);
  for (const [file, text] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const aliases = new Set(['evaluateAttempt']);
    const invokers = new Set(['createDefaultJudgeInvoker']);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) {
          const name = (binding.propertyName ?? binding.name).text;
          if (name === 'evaluateAttempt') aliases.add(binding.name.text);
          if (name === 'createDefaultJudgeInvoker') invokers.add(binding.name.text);
        }
      }
    }
    let relevant = file === AUTHORITY;
    const location = (node: ts.Node) =>
      `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = unwrap(node.expression);
        const name = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : null;
        if (name && invokers.has(name) && file === AUTHORITY) {
          relevant = true;
          evidence.legacyExecutor.push(location(node));
        }
        if (name && aliases.has(name)) {
          relevant = true;
          const arg = node.arguments[0] && unwrap(node.arguments[0]);
          const properties = arg && ts.isObjectLiteralExpression(arg) ? arg.properties : null;
          const simple = properties?.every(
            (p) =>
              (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
              (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)),
          );
          if (!properties || !simple) {
            evidence.unresolved.push(`${location(node)}: non-literal or spread evaluation input`);
          } else {
            const keys = properties.map((p) =>
              p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : '',
            );
            const entry = properties[keys.indexOf('entry')];
            const entries =
              entry && ts.isPropertyAssignment(entry) ? strings(entry.initializer) : null;
            const lane =
              keys.includes('legacy') && !keys.includes('contract')
                ? 'legacy'
                : keys.includes('contract') && !keys.includes('legacy')
                  ? 'contract'
                  : 'unknown';
            if (!entries || lane === 'unknown' || new Set(keys).size !== keys.length) {
              evidence.unresolved.push(`${location(node)}: unresolved entry/lane`);
            }
            for (const entry of entries ?? []) {
              evidence.calls.push({
                entry,
                lane,
                file,
                line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
              });
              if (!EXPECTED_GRADING_ENTRIES.some((expected) => expected === entry)) {
                evidence.unresolved.push(`${location(node)}: unknown entry ${entry}`);
              }
            }
          }
        }
      }
      // Escaped function references (including computed access) cannot silently count as migrated.
      if (
        (ts.isIdentifier(node) && aliases.has(node.text)) ||
        (ts.isStringLiteral(node) &&
          node.text === 'evaluateAttempt' &&
          ts.isElementAccessExpression(node.parent))
      ) {
        const parent = node.parent;
        const declaration =
          ts.isImportSpecifier(parent) ||
          ts.isExportSpecifier(parent) ||
          (ts.isFunctionDeclaration(parent) && parent.name === node);
        const direct = ts.isCallExpression(parent) && parent.expression === node;
        const member =
          ts.isPropertyAccessExpression(parent) &&
          parent.name === node &&
          ts.isCallExpression(parent.parent) &&
          parent.parent.expression === parent;
        if (!declaration && !direct && !member) {
          relevant = true;
          evidence.unresolved.push(`${location(node)}: indirect evaluateAttempt reference`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (relevant)
      evidence.files.push({ file, sha256: createHash('sha256').update(text).digest('hex') });
  }
  evidence.missingEntries = EXPECTED_GRADING_ENTRIES.filter(
    (entry) => !evidence.calls.some((call) => call.entry === entry),
  );
  return evidence;
}

export function collectAssessmentSourceEvidence(root: string): EvaluationSourceEvidence {
  const files: Record<string, string> = {};
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!['__tests__', '__fixtures__', 'fixtures', 'generated'].includes(entry.name))
          visit(path);
      } else if (
        /\.(ts|tsx)$/.test(entry.name) &&
        !/\.(test|spec|fixture|generated|d)\.tsx?$/.test(entry.name)
      ) {
        files[relative(root, path).replaceAll('\\', '/')] = readFileSync(path, 'utf8');
      }
    }
  };
  visit(join(root, 'src'));
  return inspectAssessmentSources(files);
}
