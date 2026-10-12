const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { parse } = require('@babel/parser');

const base = '60c4f980fce83d73b78fb912a4b097c34b8f250a';
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const evidence = resolve(root, 'docs/planning/evidence/yuk1355-a-boundary-integration');
const moves = {
  'src/server/durable/item-prior-paid-effect-adapter.ts':
    'src/capabilities/practice/server/item-prior-paid-effect-adapter.ts',
};
const unchangedBodies = [
  'src/capabilities/notes/jobs/note_verify.control.test.ts',
  'src/capabilities/notes/jobs/note_verify.ts',
  'src/capabilities/notes/public.ts',
  'src/capabilities/notes/server/paid-effect-note-admission.ts',
  'src/capabilities/notes/server/paid-effect-note-obligations.ts',
  'src/capabilities/practice/public.ts',
  'src/capabilities/practice/server/calibration-sample-durable-operation.db.test.ts',
  'src/capabilities/practice/server/calibration-sample-durable-operation.ts',
  'src/capabilities/practice/server/calibration-sample-store.ts',
  'src/core/migration/paid-effect-protocol.ts',
  'src/db/paid-effect-control.ts',
  'src/db/paid-effect-store.ts',
  'src/db/schema.ts',
  'src/server/durable/calibration-sample-family.ts',
  'src/server/durable/note-verify-family.test.ts',
  'src/server/durable/note-verify-family.ts',
  'src/server/durable/paid-effect-control.ts',
  'src/server/durable/paid-effect-protocol.test.ts',
  'src/server/durable/paid-effect-store.db.test.ts',
  'src/capabilities/practice/server/item-prior-durable-operation.ts',
  'src/capabilities/practice/jobs/item_prior_backfill.ts',
  'src/server/durable/item-prior-family.ts',
  'src/capabilities/practice/server/item-prior-durable-operation.unit.test.ts',
  'src/server/durable/item-prior-family.unit.test.ts',
  'tests/integration/item-prior-durable-member.db.test.ts',
];
const metadata = new Set([
  'start',
  'end',
  'loc',
  'extra',
  'leadingComments',
  'trailingComments',
  'innerComments',
]);

function canonical(value) {
  if (typeof value === 'bigint') return { bigint: value.toString() };
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => !metadata.has(key))
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

function hash(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

function declarations(code, path) {
  const ast = parse(code, { sourceType: 'module', plugins: ['typescript'], sourceFilename: path });
  const entries = [];
  let statementIndex = 0;
  for (const statement of ast.program.body) {
    if (statement.type === 'ImportDeclaration') continue;
    if (statement.type === 'ExportNamedDeclaration' && !statement.declaration) continue;
    if (statement.type === 'ExportAllDeclaration') continue;
    const node = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    const name =
      node.id?.name ??
      (node.type === 'VariableDeclaration'
        ? node.declarations.map((item) => item.id.name).join(',')
        : `statement-${statementIndex++}`);
    entries.push({
      name,
      kind: node.type,
      declarationAstSha256: hash(node),
      ...(node.type === 'FunctionDeclaration' ? { functionBodyAstSha256: hash(node.body) } : {}),
    });
  }
  return entries;
}

function source(path, revision) {
  return revision
    ? execFileSync('git', ['show', `${revision}:${path}`], { cwd: root, encoding: 'utf8' })
    : readFileSync(resolve(root, path), 'utf8');
}

const paths = [...Object.keys(moves), ...unchangedBodies];
const before = paths.flatMap((path) =>
  declarations(source(path, base), path).map((item) => ({
    beforePath: path,
    afterPath: moves[path] ?? path,
    ...item,
  })),
);
if (process.argv.includes('--capture-before')) {
  writeFileSync(
    resolve(evidence, 'ast-before.json'),
    `${JSON.stringify({ base, declarations: before }, null, 2)}\n`,
  );
  process.stdout.write(`Captured ${before.length} declarations at ${base}.\n`);
} else {
  const after = new Map();
  for (const path of new Set(before.map((item) => item.afterPath))) {
    after.set(path, declarations(source(path), path));
  }
  const comparisons = before.map((item) => {
    const match = after
      .get(item.afterPath)
      .find((entry) => entry.name === item.name && entry.kind === item.kind);
    return {
      ...item,
      beforeDeclarationAstSha256: item.declarationAstSha256,
      afterDeclarationAstSha256: match?.declarationAstSha256 ?? null,
      ...(item.functionBodyAstSha256
        ? {
            beforeFunctionBodyAstSha256: item.functionBodyAstSha256,
            afterFunctionBodyAstSha256: match?.functionBodyAstSha256 ?? null,
          }
        : {}),
      identical: match?.declarationAstSha256 === item.declarationAstSha256,
    };
  });
  const matched = comparisons.filter((item) => item.identical).length;
  const unexpectedDeclarations = [...after].flatMap(([path, items]) =>
    items
      .filter(
        (item) =>
          !before.some(
            (entry) =>
              entry.afterPath === path && entry.name === item.name && entry.kind === item.kind,
          ),
      )
      .map((item) => ({ path, ...item })),
  );
  const result = {
    base,
    normalization:
      'Ignore imports, re-export declarations, export wrappers and AST metadata. No declaration or body content is normalized.',
    total: before.length,
    matched,
    unexpectedDeclarations,
    comparisons,
    ok: matched === before.length && unexpectedDeclarations.length === 0,
  };
  writeFileSync(resolve(evidence, 'ast-comparison.json'), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(
    `${matched}/${before.length} declarations match; ${unexpectedDeclarations.length} unexpected declarations.\n`,
  );
  for (const item of comparisons.filter((entry) => !entry.identical)) {
    process.stdout.write(`MISMATCH ${item.beforePath}:${item.name} -> ${item.afterPath}\n`);
  }
  process.exitCode = result.ok ? 0 : 1;
}
