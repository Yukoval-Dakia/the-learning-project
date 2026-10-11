const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { parse } = require('@babel/parser');

const base = '0b45c22f246ecb1f611abb73325b47bbe38471eb';
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const evidence = resolve(root, 'docs/planning/evidence/yuk1355-a-import-initialization');
const operation = 'src/capabilities/practice/server/item-prior-durable-operation.ts';
const limits = 'src/capabilities/practice/server/item-prior-limits.ts';
const familyUnit = 'src/server/durable/item-prior-family.unit.test.ts';
const familyDb = 'src/server/durable/item-prior-family.db.test.ts';
const operationUnit = 'src/capabilities/practice/server/item-prior-durable-operation.unit.test.ts';
const integration = 'tests/integration/item-prior-durable-member.db.test.ts';
const priorFiles = JSON.parse(readFileSync(resolve(root,
  'docs/planning/evidence/yuk1355-boundary-split/product-files.json'), 'utf8')).files.map((f) => f.path);
const paths = [...new Set([...priorFiles, operation,
  'src/capabilities/practice/server/item-prior-paid-effect-adapter.ts',
  'src/server/durable/item-prior-family.ts',
  'src/capabilities/practice/jobs/item_prior_backfill.ts', familyUnit, integration])];
const metadata = new Set(['start', 'end', 'loc', 'extra', 'leadingComments', 'trailingComments', 'innerComments']);
function canonical(value) {
  if (typeof value === 'bigint') return { bigint: value.toString() };
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).filter((k) => !metadata.has(k)).sort()
    .map((k) => [k, canonical(value[k])]));
}
function hash(value) { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function source(path, before) {
  return before ? execFileSync('git', ['show', `${base}:${path}`], { cwd: root, encoding: 'utf8' })
    : readFileSync(resolve(root, path), 'utf8');
}
function ast(code) { return parse(code, { sourceType: 'module', plugins: ['typescript'] }); }
function declarations(code) {
  const result = [];
  let statement = 0;
  for (const raw of ast(code).program.body) {
    if (raw.type === 'ImportDeclaration' || raw.type === 'ExportAllDeclaration' ||
      (raw.type === 'ExportNamedDeclaration' && !raw.declaration)) continue;
    const node = raw.type === 'ExportNamedDeclaration' ? raw.declaration : raw;
    const name = node.id?.name ?? (node.type === 'VariableDeclaration'
      ? node.declarations.map((d) => d.id.name).join(',') : `statement-${statement++}`);
    result.push({ name, kind: node.type, hash: hash(node), node });
  }
  return result;
}
// Check the sole census edit structurally before reversing it for equivalence.
// Nothing else in the provider try block, arguments or surrounding function is normalized.
function undoTaskNameBinding(node) {
  const clone = structuredClone(node);
  const candidates = clone.body.body.filter((s) => s.type === 'TryStatement' &&
    s.block.body[0]?.declarations?.[0]?.id?.name === 'taskName');
  if (candidates.length !== 1) throw new Error('Expected one provider taskName binding');
  const block = candidates[0].block;
  const binding = block.body[0];
  const expected = ast('const taskName = work.taskName;').program.body[0];
  if (hash(binding) !== hash(expected)) throw new Error('Unexpected census binding');
  const call = block.body[1].declarations[0].init.argument;
  if (call.callee.object.name !== 'deps' || call.callee.property.name !== 'runTaskFn' ||
    call.arguments[0].type !== 'Identifier' || call.arguments[0].name !== 'taskName') {
    throw new Error('Unexpected census call');
  }
  block.body.shift();
  call.arguments[0] = binding.declarations[0].init;
  return clone;
}
const before = paths.flatMap((path) => declarations(source(path, true)).map(({ node, ...d }) => ({ path, ...d })));
writeFileSync(resolve(evidence, 'ast-before.json'), `${JSON.stringify({ base, declarations: before }, null, 2)}\n`);
const comparisons = before.map((d) => {
  const afterPath = d.path === familyUnit ? familyDb : d.path === operation && d.name === 'MAX_REPS' ? limits : d.path;
  const after = declarations(source(afterPath, false)).find((n) => n.name === d.name && n.kind === d.kind);
  const normalized = d.path === operation && d.name === 'executeItemPriorRep'
    ? hash(undoTaskNameBinding(after.node)) : after?.hash;
  return { ...d, afterPath, afterHash: after?.hash, identical: d.hash === after?.hash,
    equivalent: d.hash === normalized,
    ...(normalized !== after?.hash ? { censusBindingReversedHash: normalized } : {}) };
});
function rootIdentifier(node) {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression') return rootIdentifier(node.object);
  if (node.type === 'CallExpression') return rootIdentifier(node.callee);
}
function tests(code) {
  const result = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && ['it', 'test'].includes(rootIdentifier(node.callee)) &&
      node.arguments[0]?.type === 'StringLiteral') {
      result.push({ name: node.arguments[0].value, invocationHash: hash(node) });
    }
    for (const [key, value] of Object.entries(node)) {
      if (!metadata.has(key)) (Array.isArray(value) ? value : [value]).forEach(visit);
    }
  }
  visit(ast(code));
  return result;
}
const testComparisons = [operationUnit, familyUnit, integration].map((path) => {
  const afterPath = path === familyUnit ? familyDb : path;
  const expected = tests(source(path, true));
  const actual = tests(source(afterPath, false));
  return { path, afterPath, cases: expected.length, identical: hash(expected) === hash(actual), tests: expected };
});
const protectedBlobs = [...priorFiles, 'src/server/durable/item-prior-family.ts',
  'src/capabilities/practice/jobs/item_prior_backfill.ts'].map((path) => ({
    path, beforeSha256: createHash('sha256').update(source(path, true)).digest('hex'),
    afterSha256: createHash('sha256').update(source(path, false)).digest('hex'),
}));
const familyBytesIdentical = source(familyUnit, true) === source(familyDb, false);
const annotationOnlyFiles = [[familyUnit, familyDb], [integration, integration]].map(([beforePath, afterPath]) => ({
  beforePath, afterPath,
  exactCategoryReplacementOnly: source(beforePath, true).replaceAll('@invariant durability:', '@invariant data:') === source(afterPath, false),
}));
const result = { base,
  normalization: 'Ignore imports/reexports/export wrappers/metadata. MAX_REPS declaration moved unchanged. Only executeItemPriorRep census binding is explicitly reversed after exact structural checks.',
  total: comparisons.length, identical: comparisons.filter((d) => d.identical).length,
  equivalent: comparisons.filter((d) => d.equivalent).length,
  comparisons, testComparisons, protectedBlobs, familyBytesIdentical, annotationOnlyFiles,
  ok: comparisons.every((d) => d.equivalent) && testComparisons.every((d) => d.identical) &&
    protectedBlobs.every((d) => d.beforeSha256 === d.afterSha256) && annotationOnlyFiles.every((d) => d.exactCategoryReplacementOnly) };
writeFileSync(resolve(evidence, 'ast-comparison.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ total: result.total, identical: result.identical,
  equivalent: result.equivalent, testInvocations: testComparisons.reduce((n, d) => n + d.cases, 0),
  familyBytesIdentical, annotationOnlyFiles, ok: result.ok }));
process.exitCode = result.ok ? 0 : 1;
