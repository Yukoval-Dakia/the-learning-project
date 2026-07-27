import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { parse } from '@babel/parser';

const ROOT = resolve('src/capabilities');
const SOURCE_RE = /\.[cm]?[jt]sx?$/;
const TEST_RE = /\.(?:unit|db|migration|integration|e2e)?\.?test\.[cm]?[jt]sx?$/;
const CAPABILITY_IMPORT_RE = /^@\/capabilities\/([^/]+)\/(.+)$/;
const PUBLIC_ENTRYPOINTS = new Set(['public', 'ui-public']);

interface Violation {
  file: string;
  source: string;
  reason: string;
}

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = resolve(dir, name);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (SOURCE_RE.test(name) && !TEST_RE.test(name)) files.push(path);
  }
  return files;
}

function importedSources(code: string, file: string): string[] {
  const ast = parse(code, {
    sourceType: 'module',
    sourceFilename: file,
    plugins: ['typescript', 'jsx', 'dynamicImport', 'importAttributes'],
  });
  const sources = new Set<string>();

  function addLiteral(value: unknown): void {
    if (
      value &&
      typeof value === 'object' &&
      'type' in value &&
      value.type === 'StringLiteral' &&
      'value' in value &&
      typeof value.value === 'string'
    ) {
      sources.add(value.value);
    }
  }

  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    if (
      (node.type === 'ImportDeclaration' ||
        node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportAllDeclaration') &&
      node.source
    ) {
      addLiteral(node.source);
    } else if (node.type === 'ImportExpression') {
      addLiteral(node.source);
    } else if (
      node.type === 'CallExpression' &&
      node.callee &&
      typeof node.callee === 'object' &&
      'type' in node.callee &&
      node.callee.type === 'Import' &&
      Array.isArray(node.arguments)
    ) {
      addLiteral(node.arguments[0]);
    }
    for (const [key, child] of Object.entries(node)) {
      if (!['loc', 'start', 'end', 'extra'].includes(key)) visit(child);
    }
  }
  visit(ast.program);
  return [...sources];
}

function targetFor(
  source: string,
  file: string,
): { provider: string; entrypoint: string } | undefined {
  const alias = CAPABILITY_IMPORT_RE.exec(source);
  if (alias) return { provider: alias[1], entrypoint: alias[2] };
  if (!source.startsWith('.')) return undefined;

  const target = resolve(dirname(file), source);
  const fromRoot = relative(ROOT, target);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) return undefined;
  const [provider, ...rest] = fromRoot.split(sep);
  if (!provider || rest.length === 0) return undefined;
  return { provider, entrypoint: rest.join('/') };
}

function ownerFor(file: string): string | undefined {
  const [owner, ...rest] = relative(ROOT, file).split(sep);
  return rest.length > 0 ? owner : undefined;
}

const violations: Violation[] = [];
for (const capability of readdirSync(ROOT).sort()) {
  const capabilityRoot = resolve(ROOT, capability);
  if (!statSync(capabilityRoot).isDirectory()) continue;
  if (!existsSync(resolve(capabilityRoot, 'public.ts'))) {
    violations.push({
      file: relative(process.cwd(), capabilityRoot),
      source: '',
      reason: "provider capability must own a top-level 'public.ts' entrypoint",
    });
  }
}

for (const file of sourceFiles(ROOT).sort()) {
  const owner = ownerFor(file);
  for (const source of importedSources(readFileSync(file, 'utf8'), file)) {
    const target = targetFor(source, file);
    if (!target) continue;
    const { provider, entrypoint } = target;
    if (provider === owner) continue;
    if (resolve(file) === resolve(ROOT, 'index.ts') && entrypoint === 'manifest') continue;
    if (!PUBLIC_ENTRYPOINTS.has(entrypoint)) {
      violations.push({
        file: relative(process.cwd(), file),
        source,
        reason: `cross-capability imports must target '${provider}/public' or '${provider}/ui-public'`,
      });
      continue;
    }
    if (entrypoint === 'ui-public' && !relative(ROOT, file).includes(`${sep}ui${sep}`)) {
      violations.push({
        file: relative(process.cwd(), file),
        source,
        reason: 'ui-public may only be consumed by capability UI code',
      });
    }
  }
}

if (violations.length > 0) {
  console.error(`Capability boundary audit failed with ${violations.length} violation(s):`);
  for (const violation of violations) {
    console.error(`- ${violation.file}: ${violation.source} — ${violation.reason}`);
  }
  process.exit(1);
}

console.log('Capability boundary audit passed: 0 deep cross-capability imports.');
