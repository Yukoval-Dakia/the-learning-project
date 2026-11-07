import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  containerBoundaryInclude,
  dbTestInclude,
  fastTestInclude,
  migrationSmokeInclude,
} from '../vitest.shared';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const partitions = {
  unit: fastTestInclude,
  db: dbTestInclude,
  migration: migrationSmokeInclude,
  container: containerBoundaryInclude,
};
const errors: string[] = [];
const assigned = new Set<string>();
for (const [partition, files] of Object.entries(partitions)) {
  for (const file of files) {
    if (assigned.has(file)) errors.push(`Duplicate partition: ${file}`);
    assigned.add(file);
    if (!existsSync(resolve(root, file))) errors.push(`Missing ${partition} invariant: ${file}`);
  }
}
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter((file) => /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/.test(file))
  .filter((file) => existsSync(resolve(root, file)));
for (const file of tracked) {
  if (!assigned.has(file)) errors.push(`Unassigned test: ${file}`);
}

// Direct runtime DB imports belong in the DB lane; mocked modules and type-only imports do not.
for (const file of fastTestInclude) {
  if (!existsSync(resolve(root, file))) continue;
  const source = readFileSync(resolve(root, file), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const mocks = new Set<string>();
  function collectMocks(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(ast) === 'vi' &&
      ['mock', 'doMock'].includes(node.expression.name.text)
    ) {
      const specifier = node.arguments[0];
      if (specifier && ts.isStringLiteral(specifier)) mocks.add(specifier.text);
    }
    ts.forEachChild(node, collectMocks);
  }
  collectMocks(ast);
  for (const node of ast.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const clause = node.importClause;
    if (clause?.isTypeOnly) continue;
    if (
      clause &&
      !clause.name &&
      clause.namedBindings &&
      ts.isNamedImports(clause.namedBindings) &&
      clause.namedBindings.elements.every((element) => element.isTypeOnly)
    )
      continue;
    const specifier = node.moduleSpecifier.text;
    const target = specifier.startsWith('@/')
      ? `src/${specifier.slice(2)}`
      : specifier.startsWith('.')
        ? relative(root, resolve(root, dirname(file), specifier))
        : specifier;
    const isDb =
      /^(?:postgres|pg|pg-boss|drizzle-orm|drizzle-kit|testcontainers|@testcontainers\/postgresql)(?:\/|$)/.test(
        target,
      ) ||
      /^src\/db\/(?:client|schema|index)(?:\.|\/|$)/.test(target) ||
      /^tests\/helpers\/db(?:\.|$)/.test(target) ||
      /^src\/server\/boss\/(?:client|index)(?:\.|$)/.test(target);
    if (isDb && !mocks.has(specifier)) errors.push(`Unit imports live DB: ${file} -> ${specifier}`);
  }
}
const counts = Object.fromEntries(
  Object.entries(partitions).map(([name, files]) => [name, files.length]),
);
console.log(JSON.stringify({ counts, errors }, null, 2));
if (errors.length) process.exitCode = 1;
