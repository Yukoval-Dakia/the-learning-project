/**
 * Static hub-sync writer ownership audit.
 *
 * PostgreSQL topology triggers own hub-sync correctness: every knowledge/knowledge_edge write
 * dirties the affected hubs. That is safe only if the full set of topology writers is inventoried,
 * so this audit enforces four rules:
 *   UNINVENTORIED_TOPOLOGY_WRITER — topology write site absent from the comparison base.
 *   RECONCILIATION_OWNER_BYPASS — hub_sync_reconciliation write outside its sole owner.
 *   INTERNAL_APPLY_MARKER_BYPASS — app.hub_sync_internal_apply set outside that owner.
 *   DIRECT_HUB_ACTOR_APPLY — persistNoteRefineApply called with actorRef 'hub_auto_sync'.
 *
 * There is no allowlist: the comparison base is the inventory. A site present at base may stay
 * (and may be re-filed by a rename); a new site, or a new write of a table a file did not already
 * touch at base, fails. Site identity is (rule, file, discriminator) with a per-key count budget.
 *
 * Scans tracked .ts/.tsx under src/ and scripts/, excluding tests and this audit's own source
 * (which necessarily carries the marker strings).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectDrizzleWrites } from './hub-sync-writer-dataflow';
import {
  listTreeFiles,
  readBlobs,
  resolveAuditBaseSha,
  worktreeRenameMap,
} from './lib/git-base-scan';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// Sole owner of the reconciliation cursor + the internal-apply marker.
const RECONCILER_PATH = 'src/capabilities/notes/server/hub-sync-reconciliation.ts';
const TOPOLOGY_TABLES = ['knowledge', 'knowledge_edge'] as const;
const SCAN_DIRS = ['src', 'scripts'];
const SELF_PATH = 'scripts/audit-hub-sync-writers.ts';

export type HubSyncAuditRule =
  | 'UNINVENTORIED_TOPOLOGY_WRITER'
  | 'RECONCILIATION_OWNER_BYPASS'
  | 'INTERNAL_APPLY_MARKER_BYPASS'
  | 'DIRECT_HUB_ACTOR_APPLY';

export interface HubSyncAuditFinding {
  rule: HubSyncAuditRule;
  file: string;
  line: number;
  excerpt: string;
}

/** A raw write site: the file path is the rename-carried part; the discriminator is the
 *  table/marker that makes each site distinct inside one file. */
interface Hit {
  rule: HubSyncAuditRule;
  file: string;
  discriminator: string;
  index: number;
}

function normalizePath(p: string): string {
  return p.split('\\').join('/');
}

function codeText(source: string): string {
  const out: string[] = Array.from({ length: source.length }, (_, index) =>
    source[index] === '\n' ? '\n' : ' ',
  );
  const structural: string[] = [...out];

  const copy = (start: number, end: number) => {
    for (let index = start; index < end; index += 1) out[index] = source[index];
  };
  const copyStructural = (start: number, end: number) => {
    for (let index = start; index < end; index += 1) structural[index] = source[index];
  };
  const previousWord = (index: number): string => {
    let cursor = index - 1;
    while (/\s/.test(structural[cursor] ?? '')) cursor -= 1;
    const end = cursor + 1;
    while (/[\w$]/.test(structural[cursor] ?? '')) cursor -= 1;
    return structural.slice(cursor + 1, end).join('');
  };
  const previousSignificantIndex = (index: number): number => {
    let cursor = index - 1;
    while (/\s/.test(structural[cursor] ?? '')) cursor -= 1;
    return cursor;
  };
  const isSqlRawArgument = (index: number): boolean => {
    let cursor = previousSignificantIndex(index);
    if (structural[cursor] !== '(') return false;
    cursor = previousSignificantIndex(cursor);
    const rawEnd = cursor + 1;
    while (/[\w$]/.test(structural[cursor] ?? '')) cursor -= 1;
    if (structural.slice(cursor + 1, rawEnd).join('') !== 'raw') return false;
    cursor = previousSignificantIndex(cursor + 1);
    if (structural[cursor] !== '.') return false;
    return previousWord(cursor) === 'sql';
  };
  const isActorRefValue = (index: number): boolean => {
    let cursor = previousSignificantIndex(index);
    if (structural[cursor] !== ':') return false;
    cursor = previousSignificantIndex(cursor);
    if (structural[cursor] === '"' || structural[cursor] === "'") cursor -= 1;
    const end = cursor + 1;
    while (/[\w$]/.test(structural[cursor] ?? '')) cursor -= 1;
    return structural.slice(cursor + 1, end).join('') === 'actorRef';
  };
  const followsControlCondition = (index: number): boolean => {
    let cursor = previousSignificantIndex(index);
    if (structural[cursor] !== ')') return false;

    let depth = 1;
    cursor -= 1;
    while (cursor >= 0 && depth > 0) {
      if (structural[cursor] === ')') depth += 1;
      else if (structural[cursor] === '(') depth -= 1;
      cursor -= 1;
    }
    return depth === 0 && ['if', 'while', 'for', 'with'].includes(previousWord(cursor + 1));
  };
  const startsRegex = (index: number): boolean => {
    const cursor = previousSignificantIndex(index);
    if (cursor < 0 || followsControlCondition(index)) return true;
    if (/[([{=,:;!&|?+*%^~<>-]/.test(structural[cursor])) return true;
    return [
      'return',
      'throw',
      'case',
      'delete',
      'void',
      'typeof',
      'instanceof',
      'in',
      'of',
      'yield',
      'await',
    ].includes(previousWord(index));
  };

  const scanCode = (start: number, stopAtBrace: boolean): number => {
    let index = start;
    let braces = 0;
    while (index < source.length) {
      const char = source[index];
      const next = source[index + 1];

      if (stopAtBrace && char === '}' && braces === 0) return index + 1;
      if (char === '{') braces += 1;
      else if (char === '}' && braces > 0) braces -= 1;

      if (char === '/' && next === '/') {
        const end = source.indexOf('\n', index + 2);
        index = end === -1 ? source.length : end;
        continue;
      }
      if (char === '/' && next === '*') {
        const end = source.indexOf('*/', index + 2);
        index = end === -1 ? source.length : end + 2;
        continue;
      }
      if (char === '/' && startsRegex(index)) {
        let cursor = index + 1;
        let escaped = false;
        let inClass = false;
        while (cursor < source.length) {
          const current = source[cursor];
          if (!escaped && current === '[') inClass = true;
          else if (!escaped && current === ']') inClass = false;
          else if (!escaped && current === '/' && !inClass) {
            cursor += 1;
            while (/[a-z]/i.test(source[cursor] ?? '')) cursor += 1;
            break;
          }
          escaped = !escaped && current === '\\';
          cursor += 1;
        }
        index = cursor;
        continue;
      }
      if (char === "'" || char === '"') {
        const quote = char;
        const literalStart = index;
        let cursor = index + 1;
        let escaped = false;
        while (cursor < source.length) {
          const current = source[cursor];
          if (!escaped && current === quote) {
            cursor += 1;
            break;
          }
          escaped = !escaped && current === '\\';
          cursor += 1;
        }
        const actorRefValue = isActorRefValue(literalStart);
        const literalText = source.slice(literalStart + 1, cursor - 1);
        let afterLiteral = cursor;
        while (/\s/.test(source[afterLiteral] ?? '')) afterLiteral += 1;
        const actorRefKey = literalText === 'actorRef' && source[afterLiteral] === ':';
        if (actorRefValue || isSqlRawArgument(literalStart) || actorRefKey) {
          copy(literalStart, cursor);
        }
        if (actorRefValue || actorRefKey) copyStructural(literalStart, cursor);
        index = cursor;
        continue;
      }
      if (char === '`') {
        const sqlTemplate = previousWord(index) === 'sql' || isSqlRawArgument(index);
        let cursor = index + 1;
        if (sqlTemplate) copy(index, index + 1);
        while (cursor < source.length) {
          if (source[cursor] === '\\') {
            if (sqlTemplate) copy(cursor, Math.min(cursor + 2, source.length));
            cursor += 2;
            continue;
          }
          if (source[cursor] === '`') {
            if (sqlTemplate) copy(cursor, cursor + 1);
            cursor += 1;
            break;
          }
          if (source[cursor] === '$' && source[cursor + 1] === '{') {
            copy(cursor, cursor + 2);
            cursor = scanCode(cursor + 2, true);
            copy(cursor - 1, cursor);
            continue;
          }
          if (sqlTemplate) copy(cursor, cursor + 1);
          cursor += 1;
        }
        index = cursor;
        continue;
      }

      structural[index] = char;
      out[index] = char;
      index += 1;
    }
    return index;
  };

  scanCode(0, false);
  return out.join('');
}

function isScannedPath(rel: string): boolean {
  const name = rel.split('/').pop() ?? rel;
  if (!/\.(ts|tsx)$/.test(name)) return false;
  if (/\.(test|db\.test|unit\.test)\.tsx?$/.test(name)) return false;
  // Generated artifacts are type-only and can never own a hub-sync write; their mega-unions
  // also recurse trustedType into a stack overflow.
  if (/\.generated\.tsx?$/.test(name)) return false;
  if (rel.split('/').some((segment) => ['node_modules', 'dist', '.git'].includes(segment)))
    return false;
  return rel !== SELF_PATH;
}

function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      const st = statSync(abs);
      if (st.isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
        walk(abs);
        continue;
      }
      const rel = normalizePath(relative(root, abs));
      if (!isScannedPath(rel)) continue;
      out.push(abs);
    }
  };
  for (const d of SCAN_DIRS) walk(join(root, d));
  return out;
}

/** Every hub-sync ownership hit in one source file. Ref-agnostic: pass any ref's source text. */
function auditSource(sourceText: string, rel: string): Hit[] {
  const hits: Hit[] = [];
  const code = codeText(sourceText);
  const drizzleAudit = collectDrizzleWrites(sourceText, rel);
  const drizzleWrites = drizzleAudit.writes;
  const seen = new Set<string>();
  const add = (
    rule: HubSyncAuditRule,
    index: number,
    discriminator: string,
    occurrence: string,
  ) => {
    const key = `${rule}:${occurrence}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ rule, file: rel, discriminator, index });
  };

  const isReconciler = rel === RECONCILER_PATH;
  if (!isReconciler) {
    for (const write of drizzleWrites) {
      if (write.table === 'hub_sync_reconciliation') {
        add(
          'RECONCILIATION_OWNER_BYPASS',
          write.index,
          write.table,
          `${write.index}:${write.end}:${write.table}`,
        );
      }
    }
    for (const marker of drizzleAudit.internalApplyMarkers) {
      add(
        'INTERNAL_APPLY_MARKER_BYPASS',
        marker.index,
        'internal-apply-marker',
        `${marker.index}:${marker.end}:internal-marker`,
      );
    }
  }
  for (const match of code.matchAll(/(?:actorRef|['"]actorRef['"])\s*:\s*['"]hub_auto_sync['"]/g)) {
    add('DIRECT_HUB_ACTOR_APPLY', match.index, 'hub_auto_sync', String(match.index));
  }
  for (const write of drizzleWrites) {
    if (TOPOLOGY_TABLES.includes(write.table as (typeof TOPOLOGY_TABLES)[number])) {
      add(
        'UNINVENTORIED_TOPOLOGY_WRITER',
        write.index,
        write.table,
        `${write.index}:${write.end}:${write.table}`,
      );
    }
  }
  return hits;
}

function keyOf(hit: Hit): string {
  return `${hit.rule} ${hit.file} ${hit.discriminator}`;
}

function hitBudget(
  hits: readonly Hit[],
  renames?: ReadonlyMap<string, string>,
): Map<string, number> {
  const budget = new Map<string, number>();
  for (const hit of hits) {
    const file = renames?.get(hit.file) ?? hit.file;
    const key = `${hit.rule} ${file} ${hit.discriminator}`;
    budget.set(key, (budget.get(key) ?? 0) + 1);
  }
  return budget;
}

/** Head hits that exceed the per-key budget measured on the base, in scan order. */
function newHits(head: readonly Hit[], budget: ReadonlyMap<string, number>): Hit[] {
  const used = new Map<string, number>();
  const fresh: Hit[] = [];
  for (const hit of head) {
    const key = keyOf(hit);
    const count = (used.get(key) ?? 0) + 1;
    used.set(key, count);
    if (count > (budget.get(key) ?? 0)) fresh.push(hit);
  }
  return fresh;
}

function collectHitsAtRef(sha: string): Hit[] {
  const candidates = listTreeFiles(REPO_ROOT, sha, SCAN_DIRS)
    .map((entry) => normalizePath(entry.path))
    .filter(isScannedPath)
    .sort();
  const blobs = readBlobs(REPO_ROOT, sha, candidates);
  const hits: Hit[] = [];
  for (const path of candidates) {
    const text = blobs.get(path);
    if (text === undefined) continue;
    hits.push(...auditSource(text, path));
  }
  return hits;
}

function baseFlag(): string | undefined {
  const index = process.argv.indexOf('--base');
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** Scan the worktree for hub-sync ownership violations vs the comparison base. */
export function auditHubSyncWriters(input: { root: string; base: string }): {
  findings: HubSyncAuditFinding[];
  grandfathered: number;
} {
  const baseHits = collectHitsAtRef(input.base);
  const renames = worktreeRenameMap(input.root, input.base, SCAN_DIRS);
  const budget = hitBudget(baseHits, renames);

  const findings: HubSyncAuditFinding[] = [];
  let grandfathered = 0;
  for (const abs of listSourceFiles(input.root)) {
    const rel = normalizePath(relative(input.root, abs));
    const sourceText = readFileSync(abs, 'utf8');
    const hits = auditSource(sourceText, rel);
    const fresh = newHits(hits, budget);
    grandfathered += hits.length - fresh.length;
    const lines = sourceText.split('\n');
    const code = codeText(sourceText);
    for (const hit of fresh) {
      const line = code.slice(0, hit.index).split('\n').length;
      findings.push({ rule: hit.rule, file: rel, line, excerpt: lines[line - 1]?.trim() ?? '' });
    }
  }
  return { findings, grandfathered };
}

function main(): void {
  const requested = baseFlag() || process.env.CAPABILITY_BASE_SHA;
  const base = process.env.TEST_POLICY_BASE || resolveAuditBaseSha(REPO_ROOT, requested);
  const { findings, grandfathered } = auditHubSyncWriters({ root: REPO_ROOT, base });
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(findings, null, 2));
  }
  if (findings.length === 0) {
    console.log(
      `Hub sync writer audit passed (${grandfathered} inventoried sites vs base ${base.slice(0, 12)})`,
    );
    return;
  }
  console.error(`Hub sync writer audit found ${findings.length} violation(s):`);
  for (const f of findings) {
    console.error(`  [${f.rule}] ${f.file}:${f.line} — ${f.excerpt}`);
  }
  process.exitCode = 1;
}

// CLI-gate: only run when invoked directly (not when the test imports it).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
