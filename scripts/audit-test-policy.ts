import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const categories = ['data', 'grading', 'concurrency', 'security', 'crisis'];
const testPath = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/;
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function registrations(file: string, text: string) {
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const caseNames = new Set(['it', 'test']);
  const suiteNames = new Set(['describe', 'suite']);
  const namespaces = new Set<string>();
  for (const statement of ast.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== 'vitest'
    )
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        if (['it', 'test'].includes(imported)) caseNames.add(element.name.text);
        if (['describe', 'suite'].includes(imported)) suiteNames.add(element.name.text);
      }
    }
  }
  function registrationName(expression: ts.Expression): string | undefined {
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isCallExpression(expression)) return registrationName(expression.expression);
    if (ts.isTaggedTemplateExpression(expression)) return registrationName(expression.tag);
    if (ts.isPropertyAccessExpression(expression)) {
      if (ts.isIdentifier(expression.expression) && namespaces.has(expression.expression.text)) {
        return expression.name.text;
      }
      return registrationName(expression.expression);
    }
    return undefined;
  }
  // Vitest factories remain factories when saved to a variable before registration.
  let foundAlias = true;
  while (foundAlias) {
    foundAlias = false;
    function collectAlias(node: ts.Node): void {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const name = registrationName(node.initializer);
        const names =
          name && caseNames.has(name)
            ? caseNames
            : name && suiteNames.has(name)
              ? suiteNames
              : undefined;
        if (names && !names.has(node.name.text)) {
          names.add(node.name.text);
          foundAlias = true;
        }
      }
      ts.forEachChild(node, collectAlias);
    }
    collectAlias(ast);
  }
  function isFactory(call: ts.CallExpression): boolean {
    return (
      ts.isPropertyAccessExpression(call.expression) &&
      ['each', 'for', 'extend', 'runIf', 'skipIf'].includes(call.expression.name.text)
    );
  }
  function title(call: ts.CallExpression): string {
    const argument = call.arguments[0];
    return argument && ts.isStringLiteralLike(argument)
      ? argument.text
      : (argument?.getText(ast) ?? '');
  }
  const cases: { key: string; fingerprint: string; comments: string; line: number }[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      !isFactory(node) &&
      caseNames.has(registrationName(node.expression) ?? '')
    ) {
      // each/for are factories; the outer invocation registers the case.
      if (
        !(ts.isCallExpression(node.parent) && node.parent.expression === node) &&
        !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node)
      ) {
        const suites: string[] = [];
        let ancestor: ts.Node | undefined = node.parent;
        while (ancestor) {
          if (
            ts.isCallExpression(ancestor) &&
            suiteNames.has(registrationName(ancestor.expression) ?? '')
          ) {
            suites.unshift(title(ancestor));
          }
          ancestor = ancestor.parent;
        }
        const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
        cases.push({
          key: JSON.stringify([...suites, title(node)]),
          fingerprint: printer.printNode(ts.EmitHint.Unspecified, node, ast),
          comments: ranges.map((range) => text.slice(range.pos, range.end)).join('\n'),
          line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return cases;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--base')) {
    throw new Error('Usage: pnpm audit:test-policy [--base <commit>]');
  }
  const requested = args[1] ?? process.env.TEST_POLICY_BASE;
  if (process.env.CI && !requested) {
    throw new Error(
      'CI requires TEST_POLICY_BASE or --base; workflow_dispatch must supply test_policy_base.',
    );
  }
  // CI supplies the actual PR base/push parent. Locally include uncommitted changes.
  const base = requested || git(['merge-base', 'HEAD', 'origin/main']).trim();
  if (!/^[a-f0-9]{7,40}$/.test(base) || /^0+$/.test(base)) {
    throw new Error(
      'TEST_POLICY_BASE must be an existing commit SHA; fetch the comparison base first.',
    );
  }
  git(['cat-file', '-e', `${base}^{commit}`]);
  const baselineFiles = new Set(git(['ls-tree', '-r', '--name-only', base]).trim().split('\n'));
  const files =
    `${git(['diff', '--name-only', '-z', base, '--'])}${git(['ls-files', '--others', '--exclude-standard', '-z'])}`
      .split('\0')
      .filter((file) => testPath.test(file) && existsSync(resolve(root, file)));
  const errors: string[] = [];
  let checked = 0;
  let inherited = 0;
  for (const file of new Set(files)) {
    const source = readFileSync(resolve(root, file), 'utf8');
    const old = baselineFiles.has(file)
      ? registrations(file, git(['show', `${base}:${file}`]))
      : [];
    // Multiplicity matters: duplicating an inherited title/body is a new case.
    const remaining = new Map<string, number>();
    for (const item of old) {
      const key = `${item.key}\0${item.fingerprint}`;
      remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }
    for (const item of registrations(file, source)) {
      const key = `${item.key}\0${item.fingerprint}`;
      const count = remaining.get(key) ?? 0;
      if (count > 0) {
        remaining.set(key, count - 1);
        inherited++;
        continue;
      }
      checked++;
      const invariant = item.comments.match(/@invariant\s+(\w+)\s*:\s*([^\n]+)/);
      const failure = item.comments.match(/@fails-if\s+([^\n]+)/);
      if (
        !invariant ||
        !categories.includes(invariant[1]) ||
        invariant[2].trim().length < 8 ||
        !failure ||
        failure[1].trim().length < 8
      ) {
        errors.push(
          `${file}:${item.line} ${item.key}: new/changed case needs @invariant <${categories.join('|')}>: <protected outcome> and @fails-if <specific defect that breaks its assertion>. Delete UI/shape/helper-only cases; a tag is not proof, review the failure claim.`,
        );
      }
    }
  }
  console.log(
    JSON.stringify({ base, files: new Set(files).size, checked, inherited, errors }, null, 2),
  );
  if (errors.length) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
