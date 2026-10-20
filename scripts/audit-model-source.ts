/* SIZE_OK: the audit is one scan + one allowlist check; splitting it would scatter the contract. */
/**
 * YUK-1559 (C1-10) — single source of truth for model selection.
 *
 * Model-id string literals may live ONLY at their default-declaration sites:
 *   1. `defaultModel:` initializers in task definitions
 *      (src/capabilities/<owner>/tasks/**)
 *   2. the provider catalog / pricing files in PROVIDER_CATALOG_FILES below
 *      (those files ARE the catalog)
 *   3. `codeDefault:` initializers of `*_MODEL` / `*.model` keys in
 *      src/core/config/registry.ts (the system_config per-task override layer)
 *
 * Scripts, jobs, preflights and evals must read the resolved task config
 * (resolveTaskBinding / resolveTaskProvider / getConfig) instead of pinning a
 * model literal. Remaining exceptions require an entry in
 * scripts/audit-model-source-allowlist.json with reason + resolves_when.
 *
 * The model set is DERIVED — this file keeps no model list of its own:
 *   - every model id in the native pi provider catalog snapshot
 *   - every model id in the curated models.dev catalog snapshot
 *   - every model id declared in the provider catalog / pricing files
 *     (binding `models:` keys, `*MODEL*`/`*PRICE*` declarations) — this covers
 *     direct-provider lanes (embedding, GLM-OCR, legacy GLM) that are absent
 *     from the chat snapshots
 *   - every `defaultModel:` literal under src/capabilities/<owner>/tasks/**
 *   - every `*_MODEL` key's `codeDefault` in src/core/config/registry.ts
 *
 * A literal is flagged when it CONTAINS a derived model id at a non-
 * alphanumeric boundary (e.g. a composite cost_ref like
 * `unpriced:xiaomi/mimo-v2.5` still embeds the id, while `jo3i` does not match
 * the short id 'o3').
 */

import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const ALLOWLIST_PATH = join(REPO_ROOT, 'scripts/audit-model-source-allowlist.json');

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

// Allowed location (2): provider catalog / pricing surface. Model ids in these
// files are the catalog itself — anything elsewhere must resolve config.
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

// Allowed location (3): the system_config keyspace (registry codeDefaults are
// the config layer's defaults — per-task/lane overrides live in DB rows).
const CONFIG_REGISTRY_FILE = 'src/core/config/registry.ts';

const RESOLVE_KINDS = ['pr', 'phase', 'manual'] as const;

type ResolvesWhen = { kind: string; ref: string; expected_by: string };
type AllowlistEntry = { literals?: string[]; reason: string; resolves_when: ResolvesWhen };

type Finding = { file: string; line: number; literal: string; modelId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
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
      // Model object shapes: models.dev snapshot → { id, cost, … }; native pi
      // catalog snapshot → { api, input, baseUrl, … }. A provider object keys
      // model entries by id in both shapes.
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
 * Declared model ids inside the provider catalog / pricing files: `models:`
 * binding-map keys and the initializers / property names of `*MODEL*` /
 * `*PRICE*` declarations. Direct-provider lanes (embeddings, OCR, legacy GLM)
 * declare their model ids here — without this source the gate cannot see a
 * re-hard-pinned copy elsewhere.
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
  const taskDirs = readdirSync(tasksRoot)
    .map((owner) => join(tasksRoot, owner, 'tasks'))
    .filter((dir) => existsSync(dir));
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
    // `KEY: { …, codeDefault: '…', … }` where KEY ends in _MODEL.
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

// ── allowlist ────────────────────────────────────────────────────────────────

function loadAllowlist(): { entries: Record<string, AllowlistEntry>; problems: string[] } {
  if (!existsSync(ALLOWLIST_PATH)) return { entries: {}, problems: [] };
  const raw = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf-8')) as unknown;
  const entries: Record<string, AllowlistEntry> = {};
  const problems: string[] = [];
  if (!isRecord(raw)) return { entries, problems: ['allowlist root is not an object'] };
  for (const [file, value] of Object.entries(raw)) {
    if (file.startsWith('_')) continue;
    if (!isRecord(value)) {
      problems.push(`${file}: entry is not an object`);
      continue;
    }
    const entry = value as AllowlistEntry;
    if (typeof entry.reason !== 'string' || entry.reason.trim().length === 0)
      problems.push(`${file}: missing or empty reason`);
    const rw = entry.resolves_when;
    if (!isRecord(rw)) problems.push(`${file}: missing resolves_when object`);
    else {
      if (!RESOLVE_KINDS.includes(rw.kind as (typeof RESOLVE_KINDS)[number]))
        problems.push(`${file}: resolves_when.kind must be one of ${RESOLVE_KINDS.join('|')}`);
      if (typeof rw.ref !== 'string' || rw.ref.trim().length === 0)
        problems.push(`${file}: resolves_when.ref must be a non-empty string`);
      if (typeof rw.expected_by !== 'string' || !isIsoDate(rw.expected_by))
        problems.push(`${file}: resolves_when.expected_by must be a YYYY-MM-DD date`);
    }
    if (entry.literals !== undefined && !entry.literals.every((l) => typeof l === 'string'))
      problems.push(`${file}: literals must be a string array when present`);
    entries[file] = entry;
  }
  return { entries, problems };
}

/**
 * Site-level legality — a directory or registry file being "allowed" does NOT
 * license every literal inside it. Only the default-declaration positions pass:
 *   - catalog files: the whole file IS the provider catalog / pricing table;
 *   - registry.ts: a `codeDefault:` initializer under a `*_MODEL` / `*.model` key;
 *   - tasks/**: a `defaultModel:` initializer.
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
  return /^src\/capabilities\/[^/]+\/tasks\//u.test(path) && keyName === 'defaultModel';
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

  const { entries: allowlist, problems } = loadAllowlist();
  const files = SCAN_ROOTS.flatMap((root) => sourceFiles(join(REPO_ROOT, root)));

  const findings: Finding[] = [];
  const usedAllowlist = new Set<string>();
  for (const file of files) {
    const path = projectPath(file);
    const entry = allowlist[path];
    const exemptAll = entry?.literals?.includes('*') ?? false;
    const exempt = new Set(entry?.literals ?? []);
    for (const { text, line, node } of stringLiterals(readFileSync(file, 'utf-8'), file)) {
      for (const modelId of modelIds) {
        if (!containsModelId(text, modelId)) continue;
        if (isAllowedSite(path, node)) continue;
        const finding = { file: path, line, literal: text, modelId };
        if (exemptAll || exempt.has(text)) {
          usedAllowlist.add(path);
        } else {
          findings.push(finding);
        }
      }
    }
  }

  // Stale allowlist entries are findings too — they silently mask future drift.
  const stale: string[] = [];
  for (const file of Object.keys(allowlist)) {
    if (!existsSync(join(REPO_ROOT, file)))
      stale.push(`${file}: allowlisted file no longer exists`);
    else if (!usedAllowlist.has(file)) {
      const entry = allowlist[file];
      const hasMatch = entry.literals?.includes('*')
        ? false
        : stringLiterals(readFileSync(join(REPO_ROOT, file), 'utf-8'), file).some((l) =>
            (entry.literals ?? []).includes(l.text),
          );
      if (!hasMatch && !entry.literals?.includes('*')) {
        stale.push(`${file}: allowlist entry no longer matches any literal — remove it`);
      }
    }
  }

  for (const problem of problems) console.error(`allowlist hygiene: ${problem}`);
  for (const item of stale) console.error(`stale allowlist: ${item}`);
  for (const f of findings) {
    console.error(
      `model-source violation: ${f.file}:${f.line} — literal ${JSON.stringify(f.literal)} contains model id '${f.modelId}' (resolve the task config instead, or allowlist with reason + resolves_when)`,
    );
  }

  const total = findings.length + problems.length + stale.length;
  if (total === 0) {
    console.log(
      `OK audit:model-source — ${modelIds.size} derived model ids; no literals outside task defaults / provider catalog / system_config.`,
    );
    return;
  }
  console.error(`FAIL audit:model-source — ${total} problem(s).`);
  process.exit(1);
}

main();
