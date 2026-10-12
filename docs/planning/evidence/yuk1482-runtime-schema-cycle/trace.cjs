const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = process.cwd();
const { parse } = require(path.join(root, 'node_modules/@babel/parser'));
const base = '8fb160ed517c85a56cabbebfe1f1a19f137e4639';
const registered = JSON.parse(
  fs.readFileSync('docs/planning/evidence/yuk1355-a-import-initialization/import-paths.json'),
).beforeCycle;
const cache = new Map();
function edges(file, before) {
  const key = `${before}:${file}`;
  if (cache.has(key)) return cache.get(key);
  const text = before
    ? execFileSync('git', ['show', `${base}:${file}`], { encoding: 'utf8' })
    : fs.readFileSync(file, 'utf8');
  const result = parse(text, {
    sourceType: 'module',
    plugins: file.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'],
  }).program.body.flatMap((n) => {
    if (
      !n.source ||
      n.importKind === 'type' ||
      n.exportKind === 'type' ||
      (n.specifiers?.length &&
        n.specifiers.every((s) => s.importKind === 'type' || s.exportKind === 'type'))
    )
      return [];
    const specifier = n.source.value;
    const target = specifier.startsWith('@/')
      ? path.resolve(root, 'src', specifier.slice(2))
      : specifier.startsWith('.')
        ? path.resolve(path.dirname(file), specifier)
        : null;
    if (!target) return [];
    const resolved = [target, `${target}.ts`, `${target}.tsx`, path.join(target, 'index.ts')].find(
      (p) => fs.existsSync(p) && fs.statSync(p).isFile(),
    );
    if (!resolved) throw new Error(`Unresolved local import ${file}: ${specifier}`);
    return [{ from: file, line: n.loc.start.line, specifier, to: path.relative(root, resolved) }];
  });
  cache.set(key, result);
  return result;
}
const before = registered.map((e) => edges(e.from, true).find((x) => x.to === e.to));
if (before.some((e) => !e)) throw new Error('Registered cycle no longer matches the fixed base');
const removed = registered.filter((e) => !edges(e.from, false).some((x) => x.to === e.to));
const reader = 'src/kernel/read-models/failure-attempts.ts';
const seen = new Set([reader]);
const queue = [reader];
while (queue.length)
  for (const e of edges(queue.shift(), false))
    if (!seen.has(e.to)) {
      seen.add(e.to);
      queue.push(e.to);
    }
const capabilityRuntime = [...seen].filter(
  (p) => p.startsWith('src/capabilities/') || p.startsWith('src/server/'),
);
const limits = 'src/capabilities/practice/server/item-prior-limits.ts';
const result = {
  base,
  scope:
    'Registered six-edge cycle plus transitive synchronous local value imports of failure-attempts; no type-only or dynamic imports.',
  before,
  removed,
  correctedReaderImports: edges(reader, false),
  readerClosureFiles: seen.size,
  readerCapabilityOrServerDependencies: capabilityRuntime,
  limitImports: edges(limits, false),
  afterRegisteredCyclePresent: removed.length === 0,
};
console.log(JSON.stringify(result, null, 2));
if (removed.length !== 1 || capabilityRuntime.length !== 0 || edges(limits, false).length !== 0)
  process.exitCode = 1;
