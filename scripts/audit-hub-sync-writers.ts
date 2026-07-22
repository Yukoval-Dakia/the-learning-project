/**
 * YUK-384 — static hub-sync writer ownership audit.
 *
 * PostgreSQL topology triggers (drizzle/0071) own hub-sync correctness: every
 * write to `knowledge` / `knowledge_edge` dirties the affected hubs via fan-out.
 * That is only safe if the FULL set of topology writers is INVENTORIED, so this
 * lexical/static audit enforces four ownership rules:
 *
 *   UNINVENTORIED_TOPOLOGY_WRITER — a knowledge/knowledge_edge write in a path
 *     that is not in the allowlist (each allowlisted writer is justified by the
 *     trigger fan-out that covers it).
 *   RECONCILIATION_OWNER_BYPASS  — a write to `hub_sync_reconciliation` outside
 *     the sole owner `src/capabilities/notes/server/hub-sync-reconciliation.ts`.
 *   INTERNAL_APPLY_MARKER_BYPASS — setting `app.hub_sync_internal_apply` outside
 *     that same owner.
 *   DIRECT_HUB_ACTOR_APPLY       — a `persistNoteRefineApply` call with
 *     `actorRef: 'hub_auto_sync'` anywhere (the reconciler owns hub apply; there
 *     is NO escape hatch).
 *
 * Usage:
 *   pnpm audit:hub-sync-writers          # exit 0 clean, exit 1 with findings
 *   pnpm audit:hub-sync-writers --json   # JSON findings
 *
 * Scans tracked `.ts` / `.tsx` under `src/` and `scripts/` (test files and this
 * audit's own source — which necessarily carries rule marker strings — excluded).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const ALLOWLIST_PATH = resolve(__dirname, 'audit-hub-sync-writers-allowlist.json');

// Sole owner of the reconciliation cursor + the internal-apply marker.
const RECONCILER_PATH = 'src/capabilities/notes/server/hub-sync-reconciliation.ts';
const TOPOLOGY_TABLES = ['knowledge', 'knowledge_edge'] as const;
const SCAN_DIRS = ['src', 'scripts'];

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

export interface AllowlistEntry {
  path: string;
  tables: string[];
  reason: string;
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

function drizzleReceivers(
  source: string,
  code: string,
): { receivers: Set<string>; shadowed: Map<string, Array<[number, number]>> } {
  const receivers = new Set(['db', 'dbh', 'tx', 'trx']);
  const dbTypes = new Set<string>();
  const shadowed = new Map<string, Array<[number, number]>>();

  for (const match of source.matchAll(
    /\bimport\s+(?:type\s+)?{([^}]*)}\s*from\s*['"]([^'"]*db\/client)['"]/g,
  )) {
    for (const specifier of match[1].split(',')) {
      const imported = /^\s*(?:type\s+)?(db|Db|Tx)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(
        specifier,
      );
      if (!imported) continue;
      const local = imported[2] ?? imported[1];
      if (imported[1] === 'db') receivers.add(local);
      else dbTypes.add(local);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const match of code.matchAll(/\btype\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+)/g)) {
      if (
        match[2].split('|').some((part) =>
          dbTypes.has(
            part
              .trim()
              .replace(/\s*&.*$/, '')
              .trim(),
          ),
        ) &&
        !dbTypes.has(match[1])
      ) {
        dbTypes.add(match[1]);
        changed = true;
      }
    }
    for (const match of code.matchAll(
      /\b([A-Za-z_$][\w$]*)\s*\??\s*:\s*(?:typeof\s+([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)(?:\s*\|\s*([A-Za-z_$][\w$]*))?)/g,
    )) {
      const proven = match[2]
        ? receivers.has(match[2])
        : [match[3], match[4]].some((t) => dbTypes.has(t));
      if (proven && !receivers.has(match[1])) {
        receivers.add(match[1]);
        changed = true;
      }
    }
    for (const match of code.matchAll(
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\b/g,
    )) {
      if (receivers.has(match[2]) && !receivers.has(match[1])) {
        receivers.add(match[1]);
        changed = true;
      }
    }
    for (const receiver of [...receivers]) {
      const escaped = receiver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const callback = new RegExp(
        `\\b${escaped}\\s*\\.\\s*transaction\\s*\\(\\s*(?:async\\s*)?\\(?\\s*([A-Za-z_$][\\w$]*)`,
        'g',
      );
      for (const match of code.matchAll(callback)) {
        if (!receivers.has(match[1])) {
          receivers.add(match[1]);
          changed = true;
        }
      }
    }
  }

  for (const receiver of receivers) {
    const escaped = receiver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const binding = new RegExp(`\\b${escaped}\\s*:\\s*([A-Za-z_$][\\w$]*)`, 'g');
    for (const match of code.matchAll(binding)) {
      if (dbTypes.has(match[1])) continue;
      const bodyStart = code.indexOf('{', match.index + match[0].length);
      if (bodyStart < 0) continue;
      let depth = 1;
      let bodyEnd = bodyStart + 1;
      while (bodyEnd < code.length && depth > 0) {
        if (code[bodyEnd] === '{') depth += 1;
        else if (code[bodyEnd] === '}') depth -= 1;
        bodyEnd += 1;
      }
      const ranges = shadowed.get(receiver) ?? [];
      ranges.push([bodyStart, bodyEnd]);
      shadowed.set(receiver, ranges);
    }
  }

  return { receivers, shadowed };
}

function drizzleWritePattern(table: string, receivers: Set<string>): RegExp {
  const receiver = [...receivers]
    .sort((a, b) => b.length - a.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  return new RegExp(
    `\\b(${receiver})\\s*(?:\\?\\.|\\.)\\s*(?:update|insert|delete)\\s*(?:\\?\\.)?\\s*(?:<[^;()]*>)?\\s*\\(\\s*\\(*\\s*${table}\\b`,
    'g',
  );
}

function rawSqlWritePattern(table: string): RegExp {
  return new RegExp(`\\b(?:update|insert\\s+into|delete\\s+from)\\s+"?${table}\\b`, 'gi');
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
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      if (/\.(test|db\.test|unit\.test)\.tsx?$/.test(entry)) continue;
      // This audit's own source contains rule marker strings and synthetic patterns.
      if (normalizePath(relative(root, abs)) === 'scripts/audit-hub-sync-writers.ts') continue;
      out.push(abs);
    }
  };
  for (const d of SCAN_DIRS) walk(join(root, d));
  return out;
}

/**
 * Scan `root` for hub-sync ownership violations. `allowlist` inventories the
 * known topology writers; anything else is a finding.
 */
export async function auditHubSyncWriters(input: {
  root: string;
  allowlist: AllowlistEntry[];
}): Promise<HubSyncAuditFinding[]> {
  const findings: HubSyncAuditFinding[] = [];
  const allowByPath = new Map<string, Set<string>>();
  for (const entry of input.allowlist) {
    allowByPath.set(normalizePath(entry.path), new Set(entry.tables));
  }

  for (const abs of listSourceFiles(input.root)) {
    const rel = normalizePath(relative(input.root, abs));
    const isReconciler = rel === RECONCILER_PATH;
    const sourceText = readFileSync(abs, 'utf8');
    const code = codeText(sourceText);
    const { receivers, shadowed } = drizzleReceivers(sourceText, code);
    const isShadowed = (match: RegExpMatchArray): boolean =>
      (shadowed.get(match[1]) ?? []).some(
        ([start, end]) => match.index >= start && match.index < end,
      );
    const lines = sourceText.split('\n');
    const addFinding = (rule: HubSyncAuditRule, index: number) => {
      const line = code.slice(0, index).split('\n').length;
      findings.push({ rule, file: rel, line, excerpt: lines[line - 1]?.trim() ?? '' });
    };

    const reconciliationPatterns = [
      drizzleWritePattern('hub_sync_reconciliation', receivers),
      rawSqlWritePattern('hub_sync_reconciliation'),
    ];
    if (!isReconciler) {
      for (const pattern of reconciliationPatterns) {
        for (const match of code.matchAll(pattern)) {
          if (pattern === reconciliationPatterns[0] && isShadowed(match)) continue;
          addFinding('RECONCILIATION_OWNER_BYPASS', match.index);
        }
      }
      for (const match of code.matchAll(/app\.hub_sync_internal_apply/g)) {
        addFinding('INTERNAL_APPLY_MARKER_BYPASS', match.index);
      }
    }
    for (const match of code.matchAll(
      /(?:actorRef|['"]actorRef['"])\s*:\s*['"]hub_auto_sync['"]/g,
    )) {
      addFinding('DIRECT_HUB_ACTOR_APPLY', match.index);
    }
    for (const table of TOPOLOGY_TABLES) {
      if (allowByPath.get(rel)?.has(table)) continue;
      const drizzlePattern = drizzleWritePattern(table, receivers);
      for (const pattern of [drizzlePattern, rawSqlWritePattern(table)]) {
        for (const match of code.matchAll(pattern)) {
          if (pattern === drizzlePattern && isShadowed(match)) continue;
          addFinding('UNINVENTORIED_TOPOLOGY_WRITER', match.index);
        }
      }
    }
  }
  return findings;
}

export function loadAllowlist(): AllowlistEntry[] {
  let raw: { writers?: AllowlistEntry[] };
  try {
    raw = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8')) as { writers?: AllowlistEntry[] };
  } catch (err) {
    // This is a CI gate — a missing/corrupt allowlist must fail with a clear, actionable
    // message, not a raw ENOENT/SyntaxError stack.
    throw new Error(
      `audit:hub-sync-writers: cannot read/parse allowlist at ${ALLOWLIST_PATH}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return raw.writers ?? [];
}

async function main(): Promise<void> {
  const findings = await auditHubSyncWriters({ root: REPO_ROOT, allowlist: loadAllowlist() });
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(findings, null, 2));
  }
  if (findings.length === 0) {
    console.log('Hub sync writer audit passed');
    return;
  }
  console.error(`Hub sync writer audit found ${findings.length} violation(s):`);
  for (const f of findings) {
    console.error(`  [${f.rule}] ${f.file}:${f.line} — ${f.excerpt}`);
  }
  process.exitCode = 1;
}

// Run as CLI only (not when imported by the test).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
