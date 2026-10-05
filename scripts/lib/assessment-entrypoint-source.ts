import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
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
const FORMAL_ATTEMPT = 'src/capabilities/practice/server/assessment/attempt.ts';
const FORMAL_BRIDGES = ['previewFormalAttempt', 'commitFormalAttempt'] as const;

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

function moduleFile(files: Readonly<Record<string, string>>, from: string, spec: string) {
  const stem = spec.startsWith('@/')
    ? `src/${spec.slice(2)}`
    : spec.startsWith('.')
      ? normalize(join(dirname(from), spec))
      : null;
  return stem && [stem, `${stem}.ts`, `${stem}/index.ts`].find((path) => path in files);
}

/** Resolve named forwarding exports only; unsupported import shapes stay unproven. */
function importedBridge(
  files: Readonly<Record<string, string>>,
  file: string,
  localName: string,
  evidenceFiles: Set<string>,
  seen = new Set<string>(),
): boolean {
  const key = `${file}:${localName}`;
  if (seen.has(key) || !(file in files)) return false;
  seen.add(key);
  const source = ts.createSourceFile(file, files[file], ts.ScriptTarget.Latest, true);
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings) || statement.importClause?.isTypeOnly) continue;
      const binding = bindings.elements.find(
        (entry) => entry.name.text === localName && !entry.isTypeOnly,
      );
      const target = moduleFile(files, file, statement.moduleSpecifier.text);
      if (
        binding &&
        target &&
        exportedBridge(
          files,
          target,
          (binding.propertyName ?? binding.name).text,
          evidenceFiles,
          seen,
        )
      )
        return true;
    }
  }
  return false;
}

function exportedBridge(
  files: Readonly<Record<string, string>>,
  file: string,
  name: string,
  evidenceFiles: Set<string>,
  seen: Set<string>,
): boolean {
  if (file === FORMAL_ATTEMPT && FORMAL_BRIDGES.some((bridge) => bridge === name)) return true;
  const key = `${file}:${name}`;
  if (seen.has(key) || !(file in files)) return false;
  seen.add(key);
  const source = ts.createSourceFile(file, files[file], ts.ScriptTarget.Latest, true);
  for (const statement of source.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.isTypeOnly ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause)
    )
      continue;
    const binding = statement.exportClause.elements.find(
      (entry) => entry.name.text === name && !entry.isTypeOnly,
    );
    const target = moduleFile(files, file, statement.moduleSpecifier.text);
    if (
      binding &&
      target &&
      exportedBridge(
        files,
        target,
        (binding.propertyName ?? binding.name).text,
        evidenceFiles,
        seen,
      )
    ) {
      evidenceFiles.add(file);
      return true;
    }
  }
  return false;
}

/** Recognize only the two production forwarding functions, not arbitrary wrappers. */
function formalBridgeCalls(files: Readonly<Record<string, string>>) {
  const accepted = new Set<number>();
  const text = files[FORMAL_ATTEMPT];
  if (!text) return accepted;
  const source = ts.createSourceFile(FORMAL_ATTEMPT, text, ts.ScriptTarget.Latest, true);
  const authorityImport = source.statements.some((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.importClause?.isTypeOnly ||
      moduleFile(files, FORMAL_ATTEMPT, statement.moduleSpecifier.text) !== AUTHORITY
    )
      return false;
    const bindings = statement.importClause?.namedBindings;
    return (
      bindings &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some(
        (binding) =>
          !binding.isTypeOnly &&
          binding.name.text === 'evaluateAttempt' &&
          (binding.propertyName ?? binding.name).text === 'evaluateAttempt',
      )
    );
  });
  if (!authorityImport) return accepted;
  const forwards = [
    ['previewFormalAttempt', 'evaluateAttempt'],
    ['commitFormalAttempt', 'previewFormalAttempt'],
  ] as const;
  for (const [owner, target] of forwards) {
    const fn = source.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === owner,
    );
    if (!fn?.body) continue;
    const parameter = fn.parameters[1]?.name;
    if (!parameter || !ts.isIdentifier(parameter)) continue;
    const calls: ts.CallExpression[] = [];
    let rebound = false;
    const visit = (node: ts.Node) => {
      if (
        (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
        ts.isIdentifier(node.name) &&
        node.name.text === parameter.text
      )
        rebound = true;
      if (
        ts.isBinaryExpression(node) &&
        ts.isIdentifier(node.left) &&
        node.left.text === parameter.text &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      )
        rebound = true;
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === target
      )
        calls.push(node);
      ts.forEachChild(node, visit);
    };
    visit(fn.body);
    if (rebound || calls.length !== 1) continue;
    const call = calls[0];
    let statement: ts.Node = call;
    let nestedFunction = false;
    while (statement.parent && statement.parent !== fn.body) {
      statement = statement.parent;
      if (ts.isFunctionLike(statement)) nestedFunction = true;
    }
    if (nestedFunction) continue;
    if (!ts.isVariableStatement(statement) || statement.parent !== fn.body) continue;
    if (target === 'previewFormalAttempt') {
      const entry = call.arguments[1];
      if (entry && ts.isIdentifier(entry) && entry.text === parameter.text)
        accepted.add(call.getStart(source));
      continue;
    }
    const arg = call.arguments[0] && unwrap(call.arguments[0]);
    if (!arg || !ts.isObjectLiteralExpression(arg)) continue;
    const properties = arg.properties;
    if (
      !properties.every(
        (p) =>
          (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
          ts.isIdentifier(p.name),
      )
    )
      continue;
    const keys = properties.map((p) => p.name?.getText(source));
    const entry = properties.find((p) => p.name?.getText(source) === 'entry');
    const value =
      entry &&
      (ts.isShorthandPropertyAssignment(entry)
        ? entry.name
        : ts.isPropertyAssignment(entry)
          ? entry.initializer
          : null);
    if (
      value &&
      ts.isIdentifier(value) &&
      value.text === parameter.text &&
      keys.includes('contract') &&
      !keys.includes('legacy') &&
      new Set(keys).size === keys.length
    )
      accepted.add(call.getStart(source));
  }
  // Both edges must be verified before a caller can count as contract wiring.
  return accepted.size === 2 ? accepted : new Set<number>();
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
  const bridges = formalBridgeCalls(files);
  const bridgeEvidenceFiles = new Set<string>();
  if (!(AUTHORITY in files)) evidence.unresolved.push(`${AUTHORITY}: missing authority source`);
  for (const [file, text] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const aliases = new Set(['evaluateAttempt']);
    const formalAliases = new Set<string>(FORMAL_BRIDGES);
    const invokers = new Set(['createDefaultJudgeInvoker']);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) {
          const name = (binding.propertyName ?? binding.name).text;
          if (name === 'evaluateAttempt') aliases.add(binding.name.text);
          if (FORMAL_BRIDGES.some((bridge) => bridge === name))
            formalAliases.add(binding.name.text);
          if (name === 'createDefaultJudgeInvoker') invokers.add(binding.name.text);
        }
      }
    }
    const shadowed = new Set<string>();
    const collectShadows = (node: ts.Node): void => {
      if (
        (ts.isParameter(node) ||
          ts.isVariableDeclaration(node) ||
          ts.isFunctionDeclaration(node)) &&
        node.name &&
        ts.isIdentifier(node.name) &&
        formalAliases.has(node.name.text)
      ) {
        const ownDefinition =
          file === FORMAL_ATTEMPT && ts.isFunctionDeclaration(node) && node.parent === source;
        if (!ownDefinition) shadowed.add(node.name.text);
      }
      ts.forEachChild(node, collectShadows);
    };
    collectShadows(source);
    let relevant = file === AUTHORITY || file === FORMAL_ATTEMPT;
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
        const forwarding = file === FORMAL_ATTEMPT && bridges.has(node.getStart(source));
        if (name && formalAliases.has(name) && !forwarding) {
          relevant = true;
          const entries = node.arguments[1] && strings(node.arguments[1]);
          if (
            !entries ||
            bridges.size !== 2 ||
            node.arguments.some(ts.isSpreadElement) ||
            !ts.isIdentifier(callee) ||
            shadowed.has(name) ||
            !importedBridge(files, file, name, bridgeEvidenceFiles)
          ) {
            evidence.unresolved.push(`${location(node)}: unverified formal entry bridge`);
          } else {
            for (const entry of entries) {
              evidence.calls.push({
                entry,
                lane: 'contract',
                file,
                line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
              });
              if (!EXPECTED_GRADING_ENTRIES.some((expected) => expected === entry))
                evidence.unresolved.push(`${location(node)}: unknown entry ${entry}`);
            }
          }
        }
        if (name && aliases.has(name) && !forwarding) {
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
        (ts.isIdentifier(node) && (aliases.has(node.text) || formalAliases.has(node.text))) ||
        (ts.isStringLiteral(node) &&
          (node.text === 'evaluateAttempt' || FORMAL_BRIDGES.some((name) => name === node.text)) &&
          ts.isElementAccessExpression(node.parent))
      ) {
        const parent = node.parent;
        const declaration =
          ts.isImportSpecifier(parent) ||
          ts.isExportSpecifier(parent) ||
          ts.isTypeQueryNode(parent) ||
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
  for (const file of bridgeEvidenceFiles) {
    if (!evidence.files.some((entry) => entry.file === file))
      evidence.files.push({ file, sha256: createHash('sha256').update(files[file]).digest('hex') });
  }
  evidence.files.sort((a, b) => a.file.localeCompare(b.file));
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
