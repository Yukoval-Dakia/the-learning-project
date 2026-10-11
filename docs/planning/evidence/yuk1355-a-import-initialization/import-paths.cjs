const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { dirname, resolve, relative } = require('node:path');
const { parse } = require('@babel/parser');

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const base = '0b45c22f246ecb1f611abb73325b47bbe38471eb';
const op = 'src/capabilities/practice/server/item-prior-durable-operation.ts';
const adapter = 'src/capabilities/practice/server/item-prior-paid-effect-adapter.ts';
const limits = 'src/capabilities/practice/server/item-prior-limits.ts';
function edges(path, before) {
  const code = before ? execFileSync('git', ['show', `${base}:${path}`], { cwd: root, encoding: 'utf8' })
    : readFileSync(resolve(root, path), 'utf8');
  return parse(code, { sourceType: 'module', plugins: ['typescript'] }).program.body.flatMap((node) => {
    if (!node.source || node.importKind === 'type' || node.exportKind === 'type' ||
      (node.specifiers?.length && node.specifiers.every((s) => s.importKind === 'type' || s.exportKind === 'type'))) return [];
    const specifier = node.source.value;
    const target = specifier.startsWith('@/') ? resolve(root, 'src', specifier.slice(2))
      : specifier.startsWith('.') ? resolve(root, dirname(path), specifier) : null;
    if (!target) return [];
    const file = [target, `${target}.ts`, `${target}.tsx`, resolve(target, 'index.ts')].find(existsSync);
    return file ? [{ from: path, line: node.loc.start.line, specifier, to: relative(root, file) }] : [];
  });
}
function shortest(from, to, before) {
  const queue = [{ path: from, edges: [] }];
  const seen = new Set([from]);
  while (queue.length) {
    const current = queue.shift();
    for (const edge of edges(current.path, before)) {
      const path = [...current.edges, edge];
      if (edge.to === to) return path;
      if (!seen.has(edge.to)) { seen.add(edge.to); queue.push({ path: edge.to, edges: path }); }
    }
  }
  return null;
}
const result = { base, scope: 'Synchronous local value imports/reexports only; excludes type-only and dynamic imports.',
  beforeCycle: [...shortest(op, adapter, true), ...shortest(adapter, op, true)],
  afterLimitDependencies: { operation: shortest(op, limits, false), adapter: shortest(adapter, limits, false), leaf: edges(limits, false) },
  existingPublicCycleStillPresent: Boolean(shortest(op, adapter, false) && shortest(adapter, op, false)) };
writeFileSync(resolve(root, 'docs/planning/evidence/yuk1355-a-import-initialization/import-paths.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
