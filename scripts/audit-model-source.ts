/* SIZE_OK: the audit is one scan + one allowlist check; splitting it would scatter the contract. */
/**
 * Single source of truth for model selection.
 *
 * Model-id literals may live only at their default-declaration sites:
 *   1. `defaultModel:` initializers in task definitions under src/capabilities/<owner>/tasks/** (practice sub-owners: practice/<owner>/tasks/**);
 *   2. the provider catalog / pricing files (those files ARE the catalog);
 *   3. `codeDefault:` initializers of `*_MODEL` / `*.model` keys in the config registry.
 *
 * Everything else reads the resolved task config. A literal site is illegal when it was not
 * already present on the comparison base — the base is the inventory, there is no allowlist.
 *
 * The model set is derived from the catalog snapshots, catalog declarations, task defaults, and
 * registry code defaults — this file keeps no model list of its own. A literal is flagged when it
 * contains a derived id on a non-alphanumeric boundary, so a composite cost_ref still matches while
 * `jo3i` does not match 'o3'. Site identity is (file, literal text, model id) with a per-key count
 * budget; renames carry the file's budget across.
 */

import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  listTreeFiles,
  readBlobs,
  resolveAuditBaseSha,
  worktreeRenameMap,
} from './lib/git-base-scan';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const SCAN_ROOTS = ['src', 'server', 'scripts', 'web'];
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts)$/u;
const TEST_FILE = /\.(?:unit|db|migration|integration|e2e)?\.?(?:test|spec)\.(?:ts|tsx|mts|cts)$/u;
const TEST_SUPPORT_FILE = /\.test-support\.(?:ts|tsx|mts|cts)$/u;
const EXCLUDED_DIRS = new Set([
  'node_modules',
  'fixtures',
  '__fixtures__',
  'generated',
  '__generated__',
  'vendor',
  'dist',
  '.claude',
]);

// Allowed location (2): provider catalog / pricing surface. Model ids in these files are the
// catalog itself; everything elsewhere must resolve config.
const PROVIDER_CATALOG_FILES = new Set([
  'src/server/ai/providers.ts',
  'src/server/ai/pricing.ts',
  'src/server/ai/model-catalog-overrides.ts',
  'src/server/ai/model-profiles.ts',
  'src/server/ai/pi-models.ts',
  'src/server/ai/pi-provider-catalog.ts',
  'src/server/ai/pi-catalog-cost.ts',
  'src/server/ai/xiaomi-token-plan.ts',
]);

// Allowed location (3): the system_config keyspace (registry defaults; per-task/lane overrides
// live in DB rows).
const CONFIG_REGISTRY_FILE = 'src/core/config/registry.ts';

type Finding = { file: string; line: number; literal: string; modelId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function projectPath(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join('/');
}

function sourceFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root).sort((a, b) => a.localeCompare(b))) {
    const path = resolve(root, entry);
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) throw new Error(`${path}: symbolic link found while scanning`);
    if (stats.isDirectory() && !EXCLUDED_DIRS.has(entry)) files.push(...sourceFiles(path));
    else if (
      SOURCE_FILE.test(entry) &&
      !TEST_FILE.test(entry) &&
      !TEST_SUPPORT_FILE.test(entry) &&
      !entry.endsWith('.generated.ts')
    )
      files.push(path);
  }
  return files;
}

function scriptKind(filename: string): ts.ScriptKind {
  return extname(filename) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

/** Every string literal (incl. template-without-substitution) in the file. */
function stringLiterals(
  code: string,
  filename: string,
): Array<{ text: string; line: number; node: ts.StringLiteralLike }> {
  const sourceFile = ts.createSourceFile(
    filename,
    code,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(filename),
  );
  const out: Array<{ text: string; line: number; node: ts.StringLiteralLike }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      out.push({ text: node.text, line: line + 1, node });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

// ── derived model set (no hand-maintained list in this file) ────────────────

function catalogModelIds(): Set<string> {
  const ids = new Set<string>();
  for (const snapshot of [
    'src/server/ai/pi-provider-catalog.snapshot.json',
    'src/server/ai/model-catalog.snapshot.json',
  ]) {
    const path = join(REPO_ROOT, snapshot);
    if (!existsSync(path)) continue;
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    const collect = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) collect(item);
        return;
      }
      if (!isRecord(node)) return;
      // Both snapshots key model entries by id: models.dev uses { id, cost }, native pi uses
      // { api, input, baseUrl }. Treat either shape as a model object.
      const looksLikeModel = (value: Record<string, unknown>): boolean =>
        (typeof value.id === 'string' && (isRecord(value.cost) || isRecord(value.capabilities))) ||
        (typeof value.api === 'string' && Array.isArray(value.input));
      if (typeof node.id === 'string' && looksLikeModel(node)) ids.add(node.id);
      for (const [key, value] of Object.entries(node)) {
        if (isRecord(value) && looksLikeModel(value)) ids.add(key);
        collect(value);
      }
    };
    collect(parsed);
  }
  return ids;
}

/**
 * Declared model ids inside the provider catalog / pricing files: `models:` binding-map keys and
 * initializers/property names of `*MODEL*` / `*PRICE*` declarations. This is how direct-provider
 * lanes (embeddings, OCR, legacy GLM) are seen.
 */
function catalogDeclaredModelIds(): Set<string> {
  const ids = new Set<string>();
  const propName = (name: ts.PropertyName | undefined): void => {
    if (name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name))) ids.add(name.text);
  };
  for (const relPath of PROVIDER_CATALOG_FILES) {
    const file = join(REPO_ROOT, relPath);
    if (!existsSync(file)) continue;
    const sourceFile = ts.createSourceFile(
      file,
      readFileSync(file, 'utf-8'),
      ts.ScriptTarget.Latest,
      true,
      scriptKind(file),
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'models' &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        for (const prop of node.initializer.properties) propName(prop.name);
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        /MODEL|PRICE|PRICING/iu.test(node.name.text)
      ) {
        const init = node.initializer;
        if (init && ts.isStringLiteralLike(init)) ids.add(init.text);
        if (init && ts.isObjectLiteralExpression(init)) {
          for (const prop of init.properties) propName(prop.name);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return ids;
}

function taskDefaultModelIds(): Set<string> {
  const ids = new Set<string>();
  const tasksRoot = join(REPO_ROOT, 'src/capabilities');
  // Practice sub-owners (`practice/<owner>/tasks`) declare task defaults one level deeper.
  const practiceRoot = join(tasksRoot, 'practice');
  const taskDirs = [
    ...readdirSync(tasksRoot).map((owner) => join(tasksRoot, owner, 'tasks')),
    ...readdirSync(practiceRoot).map((owner) => join(practiceRoot, owner, 'tasks')),
  ].filter((dir) => existsSync(dir));
  for (const file of taskDirs.flatMap(sourceFiles)) {
    const sourceFile = ts.createSourceFile(
      file,
      readFileSync(file, 'utf-8'),
      ts.ScriptTarget.Latest,
      true,
      scriptKind(file),
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'defaultModel' &&
        ts.isStringLiteralLike(node.initializer)
      ) {
        ids.add(node.initializer.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return ids;
}

function registryModelCodeDefaults(): Set<string> {
  const ids = new Set<string>();
  const file = join(REPO_ROOT, CONFIG_REGISTRY_FILE);
  const sourceFile = ts.createSourceFile(
    file,
    readFileSync(file, 'utf-8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const visit = (node: ts.Node): void => {
    // `KEY: { ..., codeDefault: '...', ... }` where KEY ends in _MODEL.
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      /_MODEL$/u.test(node.name.text)
    ) {
      const body = node.initializer;
      if (ts.isObjectLiteralExpression(body)) {
        for (const prop of body.properties) {
          if (
            ts.isPropertyAssignment(prop) &&
            ts.isIdentifier(prop.name) &&
            prop.name.text === 'codeDefault' &&
            ts.isStringLiteralLike(prop.initializer)
          ) {
            ids.add(prop.initializer.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return ids;
}

/**
 * Site-level legality: an allowed file does not license every literal in it. Catalog files are
 * wholly catalogs; registry.ts only allows `codeDefault:` under a *_MODEL / *.model key; tasks/**
 * only allows `defaultModel:`.
 */
function isAllowedSite(path: string, node: ts.StringLiteralLike): boolean {
  if (PROVIDER_CATALOG_FILES.has(path)) return true;
  const parent = node.parent;
  if (!ts.isPropertyAssignment(parent) || parent.initializer !== node) return false;
  const keyName =
    ts.isIdentifier(parent.name) || ts.isStringLiteralLike(parent.name)
      ? parent.name.text
      : undefined;
  if (path === CONFIG_REGISTRY_FILE) {
    if (keyName !== 'codeDefault') return false;
    const keyDecl = parent.parent.parent;
    if (!ts.isPropertyAssignment(keyDecl)) return false;
    const scope =
      ts.isIdentifier(keyDecl.name) || ts.isStringLiteralLike(keyDecl.name)
        ? keyDecl.name.text
        : undefined;
    return scope !== undefined && (/_MODEL$/u.test(scope) || /\.model$/u.test(scope));
  }
  return (
    /^src\/capabilities\/(?:[^/]+|practice\/[^/]+)\/tasks\//u.test(path) &&
    keyName === 'defaultModel'
  );
}

/** The id must sit on a non-alphanumeric boundary — `jo3i` is not the model 'o3'. */
function containsModelId(text: string, modelId: string): boolean {
  let index = text.indexOf(modelId);
  while (index !== -1) {
    const before = index > 0 ? text[index - 1] : '';
    const after = index + modelId.length < text.length ? text[index + modelId.length] : '';
    if (!/[a-zA-Z0-9]/u.test(before) && !/[a-zA-Z0-9]/u.test(after)) return true;
    index = text.indexOf(modelId, index + 1);
  }
  return false;
}

/** Every illegal model-id literal in one source file. Ref-agnostic: pass any ref's text. */
function literalViolations(path: string, source: string, modelIds: ReadonlySet<string>): Finding[] {
  const out: Finding[] = [];
  for (const { text, line, node } of stringLiterals(source, path)) {
    for (const modelId of modelIds) {
      if (!containsModelId(text, modelId)) continue;
      if (isAllowedSite(path, node)) continue;
      out.push({ file: path, line, literal: text, modelId });
    }
  }
  return out;
}

function isScannedPath(rel: string): boolean {
  const name = rel.split('/').pop() ?? rel;
  if (!SOURCE_FILE.test(name)) return false;
  if (TEST_FILE.test(name) || TEST_SUPPORT_FILE.test(name)) return false;
  if (name.endsWith('.generated.ts')) return false;
  return !rel.split('/').some((segment) => EXCLUDED_DIRS.has(segment));
}

function keyOf(finding: Pick<Finding, 'file' | 'literal' | 'modelId'>): string {
  return JSON.stringify([finding.file, finding.literal, finding.modelId]);
}

function budgetFrom(
  findings: readonly Finding[],
  renames: ReadonlyMap<string, string>,
): Map<string, number> {
  const budget = new Map<string, number>();
  for (const finding of findings) {
    const key = keyOf({ ...finding, file: renames.get(finding.file) ?? finding.file });
    budget.set(key, (budget.get(key) ?? 0) + 1);
  }
  return budget;
}

/** Head findings whose key count exceeds the base budget, in scan order. */
function newFindings(head: readonly Finding[], budget: ReadonlyMap<string, number>): Finding[] {
  const used = new Map<string, number>();
  const fresh: Finding[] = [];
  for (const finding of head) {
    const key = keyOf(finding);
    const count = (used.get(key) ?? 0) + 1;
    used.set(key, count);
    if (count > (budget.get(key) ?? 0)) fresh.push(finding);
  }
  return fresh;
}

function collectAtRef(sha: string, modelIds: ReadonlySet<string>): Finding[] {
  const candidates = listTreeFiles(REPO_ROOT, sha, SCAN_ROOTS)
    .map((entry) => entry.path.split('\\').join('/'))
    .filter(isScannedPath)
    .sort();
  const blobs = readBlobs(REPO_ROOT, sha, candidates);
  const findings: Finding[] = [];
  for (const path of candidates) {
    const text = blobs.get(path);
    if (text === undefined) continue;
    findings.push(...literalViolations(path, text, modelIds));
  }
  return findings;
}

function baseFlag(): string | undefined {
  const index = process.argv.indexOf('--base');
  return index >= 0 ? process.argv[index + 1] : undefined;
}

// ── main ────────────────────────────────────────────────────────────────────

function main(): void {
  const modelIds = new Set([
    ...catalogModelIds(),
    ...catalogDeclaredModelIds(),
    ...taskDefaultModelIds(),
    ...registryModelCodeDefaults(),
  ]);
  if (modelIds.size === 0) {
    console.error('FAIL audit:model-source — derived model set is empty (catalog unreadable?)');
    process.exit(1);
  }

  const requested = baseFlag() || process.env.CAPABILITY_BASE_SHA;
  const base = process.env.TEST_POLICY_BASE || resolveAuditBaseSha(REPO_ROOT, requested);
  const budget = budgetFrom(
    collectAtRef(base, modelIds),
    worktreeRenameMap(REPO_ROOT, base, SCAN_ROOTS),
  );

  const files = SCAN_ROOTS.flatMap((root) => sourceFiles(join(REPO_ROOT, root)));
  const findings: Finding[] = [];
  let grandfathered = 0;
  for (const file of files) {
    const path = projectPath(file);
    const hits = literalViolations(path, readFileSync(file, 'utf-8'), modelIds);
    const fresh = newFindings(hits, budget);
    grandfathered += hits.length - fresh.length;
    findings.push(...fresh);
  }

  for (const f of findings) {
    console.error(
      `model-source violation: ${f.file}:${f.line} — literal ${JSON.stringify(f.literal)} contains model id '${f.modelId}' (resolve the task config instead)`,
    );
  }

  if (findings.length === 0) {
    console.log(
      `OK audit:model-source — ${modelIds.size} derived model ids; ${grandfathered} literals grandfathered from base ${base.slice(0, 12)}, none new.`,
    );
    return;
  }
  console.error(`FAIL audit:model-source — ${findings.length} new violation(s) vs base.`);
  process.exit(1);
}

main();
