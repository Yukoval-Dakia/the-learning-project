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
 * Scans tracked `.ts` / `.tsx` under `src/` and `scripts/` (test files and the
 * audit scripts themselves — which carry table-name marker strings — excluded).
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

// A source line stripped of its comment portion, or null if the whole line is a
// comment (so table names inside comments never register as writes).
function codePortion(line: string): string | null {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return null;
  const commentIdx = line.indexOf('//');
  return commentIdx === -1 ? line : line.slice(0, commentIdx);
}

function writesTable(code: string, table: string): boolean {
  // Drizzle form: .update(table) / .insert(table) / .delete(table)
  const drizzle = new RegExp(`\\.(update|insert|delete)\\(\\s*${table}\\b`);
  // Raw SQL: update table / insert into table / delete from table
  const raw = new RegExp(`\\b(update|insert\\s+into|delete\\s+from)\\s+"?${table}\\b`, 'i');
  return drizzle.test(code) || raw.test(code);
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
      // Audit scripts carry table-name marker strings; never scan them.
      if (/(^|\/)audit-[^/]*\.ts$/.test(normalizePath(abs))) continue;
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
    const lines = readFileSync(abs, 'utf8').split('\n');

    lines.forEach((rawLine, index) => {
      const code = codePortion(rawLine);
      if (code === null) return;
      const line = index + 1;
      const excerpt = rawLine.trim();

      if (!isReconciler && writesTable(code, 'hub_sync_reconciliation')) {
        findings.push({ rule: 'RECONCILIATION_OWNER_BYPASS', file: rel, line, excerpt });
      }
      if (!isReconciler && /app\.hub_sync_internal_apply/.test(code)) {
        findings.push({ rule: 'INTERNAL_APPLY_MARKER_BYPASS', file: rel, line, excerpt });
      }
      if (/actorRef\s*:\s*['"]hub_auto_sync['"]/.test(code)) {
        findings.push({ rule: 'DIRECT_HUB_ACTOR_APPLY', file: rel, line, excerpt });
      }
      for (const table of TOPOLOGY_TABLES) {
        if (writesTable(code, table) && !allowByPath.get(rel)?.has(table)) {
          findings.push({ rule: 'UNINVENTORIED_TOPOLOGY_WRITER', file: rel, line, excerpt });
        }
      }
    });
  }
  return findings;
}

export function loadAllowlist(): AllowlistEntry[] {
  const raw = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8')) as {
    writers?: AllowlistEntry[];
  };
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
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
