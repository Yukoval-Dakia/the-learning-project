/**
 * audit:fold-writes — fold-owned 表 raw-write 反向审计（红线审查 wave F / A4）
 *
 * 决策来源：红线挑战审查（2026-07-07）§5 条目 6「audit:fold-writes（A4）：fold-owned 表
 * raw UPDATE 静态扫——补最高危不变量的机器兜底（横切 #2 的第一刀）」。A4-throat 簇终裁
 * KEEP-WITH-COST：event-sourcing 咽喉红线（fold-owned 表禁 raw UPDATE，一切修复须走事件层 /
 * 单写者咽喉）条文健康，但其执行「靠人肉不靠机器 gate」——knowledge_edge 曾 LIVE fold-owned
 * 而 raw-endpoint UPDATE 缺口在生产活跃数周（docs/design/2026-07-02-kc-dedup-attribution-
 * rewrite-spec.md §7 finding 1）。本审计把「谁可以写 fold-owned 表」这条纯人肉不变量做成
 * 机器可见的 FORWARD drift-guard。
 *
 * ── 什么是 fold-owned 表 ────────────────────────────────────────────────────
 *
 * ADR-0044 event-sourcing 地基改造把 7 张 projection 表（knowledge / knowledge_edge / goal /
 * mistake_variant / learning_item / artifact / question_block）纳入「事件唯一真相，projection
 * 是缓存」：每张表的**单写者咽喉** = `src/server/projections/<table>.ts` 的 write-through shell
 * （fold(events)→row），核心 reducer 在 `src/core/projections/<table>.ts`。SoT-flip 由
 * `src/server/projections/sot-flag.ts` 的 `projectionIsWriter(entity?)` 门控：
 *   - knowledge / knowledge_edge：全局 `PROJECTION_IS_WRITER`，运行值须另查部署。
 *   - goal / mistake_variant / learning_item：canonical 单写者，已退休 env 分支。
 *   - artifact / question_block：仍保留 per-entity env 门控，部署状态以真实 runtime 为准。
 *
 * 「咽喉」= 当 flag ON 时 projection shell 写行；当 OFF 时命令式 applier 写行（**同 tx writeEvent
 * + guarded by projectionIsWriter** 的 dual-path）。红线要防的失效：一个**既不是 projection shell、
 * 又不 event-native**的 raw UPDATE/DELETE/INSERT 直接改 fold-owned 行 —— 它对 fold 不可见，rebuild
 * 时被「复活」或抹掉（kc-dedup spec §7 finding 1 的确诊病灶）。
 *
 * ── 判据 ────────────────────────────────────────────────────────────────────
 *
 * 声明式 `SANCTIONED_WRITERS` registry（手维护，每条带 file:marker 反查证据 + role 分级）列出
 * 今天**合法**写每张 fold-owned 表的文件全集：projection shell（throat）/ core reducer /
 * gated-dual-path（命令式 applier，gate on projectionIsWriter，ON 时让位 shell）/
 * event-native-by-caller（raw write，调用者负责同事务事件）/ off-path-writer（OFF 表当前唯一
 * 合法写者，翻转前）/ seed（初始数据集播种）/ maintenance（非 fold 字段旁路维护）。
 *
 * 扫描器（`findWriteSites`）在**剥注释保字符串**的源码上抓每个写点：
 *   - Drizzle 形：`.update(<table>)` / `.insert(<table>)` / `.delete(<table>)`（bare 标识符，
 *     `)` 消歧 knowledge vs knowledge_edge）。
 *   - raw SQL 形：字符串/模板里的 `UPDATE <table>` / `DELETE FROM <table>` / `INSERT INTO <table>`
 *     （包括 Notes hub reconciliation 的现役 raw SQL 写点）。
 * 命中且其**文件**不在该表的 sanctioned_writers ∪ allowlist ⇒ VIOLATION。
 *
 * 三类输出：
 *   - VIOLATION       —— 写点在未声明为合法写者的文件里（新增的绕过咽喉的 raw 写 → 红线兜底命中）。
 *   - ALLOWLISTED     —— 写点文件在 allowlist（带 reason + resolves_when{kind,ref,expected_by}）。
 *   - STALE-REGISTRY  —— 声明的 sanctioned_writer 的 marker 在文件里不再命中（registry ↔ 代码漂移：
 *                        写者被删/改名 → 该条 registry 是死配置，应清理）。
 *
 * ── 默认 report-only（exit 0）；--strict 才非零 exit ────────────────────────────
 *
 * 与 audit:relations / audit:mastery-provenance 同待遇：默认只报告、**不进 `pnpm test` 硬链**
 * （保持 advisory）。`--strict` 下 VIOLATION>0 或 STALE>0 才非零 exit（升级为 CI gate 是 owner
 * 决策——横切 #2「执行强度与爆炸半径倒挂」的第一刀，是否上硬 gate 由 owner 拍）。
 *
 * ── 已知限制（同 audit:relations 的 shape 限制，不代码修）─────────────────────────
 *
 * (1) 判据是**文件级**：一个已 sanctioned 的文件里新增的 raw 写不会被抓（同 audit:relations 的
 *     file:marker 文件级反查）。价值在抓「NEW 文件绕过咽喉」——正是 kc-dedup spec 的确诊场景。
 * (2) SANCTIONED_WRITERS 手维护：新增合法写 fold-owned 表的文件时须在此补一条（否则误报 VIOLATION）。
 *     反查只防「声明的写者消失」，不能自动发现「未声明的新合法写者」。
 * (3) role 分级是**声明式信息**（供报告分组 + 曝光 LIVE 表的 ungated 写者），不改判据——sanctioned =
 *     在 registry（任一 role）。零 VIOLATION 只证明登记完整，不替代同事务事件/回放行为验证。
 *
 * 用法：
 *   pnpm audit:fold-writes          # 报告（report-only）
 *   pnpm audit:fold-writes --json   # JSON 输出
 *   pnpm audit:fold-writes --strict # VIOLATION 或 STALE 即非零 exit（CI gate 模式）
 */

import { type Dirent, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const ALLOWLIST_PATH = join(__dirname, 'audit-fold-writes-allowlist.json');

// Scan roots: writers to fold-owned tables live under src/ and the top-level server/ (Hono
// composition root). scripts/ are excluded — they orchestrate the projection shells, never write
// fold rows directly (rebuild-projection.ts goes THROUGH the shell). Standard build/vendor dirs +
// nested worktrees are pruned.
const SCAN_ROOTS = ['src', 'server'] as const;
const EXCLUDE_DIRS = new Set(['node_modules', '.next', 'dist', '.git', '.claude', 'drizzle']);
// The audit's own files must not scan themselves (they name the tables in doc examples).
const EXCLUDE_FILES = new Set([
  'scripts/audit-fold-writes.ts',
  'scripts/audit-fold-writes.test.ts',
]);

// ── fold-owned table universe (ADR-0044; grounded in entity-registry.ts PROJECTION_ENTITIES) ──
export const FOLD_OWNED_TABLES = [
  'knowledge',
  'knowledge_edge',
  'goal',
  'mistake_variant',
  'learning_item',
  'artifact',
  'question_block',
  'item_calibration',
] as const;
export type FoldOwnedTable = (typeof FOLD_OWNED_TABLES)[number];

/** Code policy, not deployment telemetry. Switchable tables need the same scrutiny when ON. */
export const FOLD_WRITE_POLICY: Record<FoldOwnedTable, 'canonical' | 'switchable' | 'anchor-only'> =
  {
    knowledge: 'switchable',
    knowledge_edge: 'switchable',
    goal: 'canonical',
    mistake_variant: 'canonical',
    learning_item: 'canonical',
    artifact: 'canonical',
    question_block: 'canonical',
    item_calibration: 'anchor-only',
  };

export type WriterRole =
  | 'throat' // projection write-through shell (the fold row writer)
  | 'reducer' // core fold reducer
  | 'gated-dual-path' // imperative applier gated on projectionIsWriter (defers to shell when ON)
  | 'event-native-by-caller' // raw row write; caller appends the matching event in the same tx
  | 'off-path-writer' // imperative writer under an explicit anchor-only policy
  | 'seed' // initial dataset seed
  | 'maintenance'; // rewrites a non-fold column (e.g. embedding backfill), not a fold-truth mutation

/** One declared legitimate writer of a fold-owned table. `marker` reverse-checked for drift. */
export type SanctionedWriter = {
  table: FoldOwnedTable;
  /** repo-relative file allowed to write `table`. */
  file: string;
  /** literal substring that MUST still appear in `file` (drift reverse-check). */
  marker: string;
  role: WriterRole;
  note: string;
};

// ── SANCTIONED_WRITERS registry ────────────────────────────────────────────────────────────────
//
// grounding (2026-07-07 实读于 origin/main worktree)：per-table write-site sweep
// `grep -rnE '\.(update|insert|delete)\(<table>\)' src/ server/` + `projectionIsWriter` gating check.
// Each entry's `marker` is a representative write expression that reverse-check requires to persist.
export const SANCTIONED_WRITERS: SanctionedWriter[] = [
  // ---- knowledge (LIVE) ----
  {
    table: 'knowledge',
    file: 'src/server/projections/knowledge.ts',
    marker: '.insert(knowledge)',
    role: 'throat',
    note: 'projection write-through shell — the fold row writer for knowledge (ADR-0044 W1, LIVE).',
  },
  {
    table: 'knowledge',
    file: 'src/capabilities/knowledge/server/proposals.ts',
    marker: 'projectionIsWriter()',
    role: 'event-native-by-caller',
    note: 'mixed accept-path file: propose_new gates its INSERT, but reparent/archive/merge/split perform unconditional imperative UPDATEs paired with the accepted mutation event in the caller-owned transaction. Classify by its least-locally-guarded writes so LIVE advisory cannot hide them.',
  },
  {
    table: 'knowledge',
    file: 'src/capabilities/knowledge/server/learning-intent-knowledge.ts',
    marker: '.insert(knowledge)',
    role: 'event-native-by-caller',
    note: 'Tx-only node creation; Agency materialization supplies the accepted learning-item proposal/rate and materialized-id mapping used by knowledge fold.',
  },
  {
    table: 'knowledge',
    file: 'src/capabilities/knowledge/server/seed.ts',
    marker: '.insert(knowledge)',
    role: 'seed',
    note: 'migrate-time subject-root seed; each newly inserted row writes same-tx experimental:genesis + materialized_id_index anchor. Kept as seed role so LIVE advisory continuously re-verifies that bootstrap contract.',
  },
  {
    table: 'knowledge',
    file: 'src/server/subjects/ensure-subject-root.ts',
    marker: '.insert(knowledge)',
    role: 'event-native-by-caller',
    note: 'runtime custom-subject root creation accepts Tx only and writes same-tx experimental:genesis + materialized_id_index anchor.',
  },
  {
    table: 'knowledge',
    file: 'src/server/subjects/subject-control-write.ts',
    marker: '.update(knowledge)',
    role: 'event-native-by-caller',
    note: 'rename/reset mirror subject display_name into root.name and append a same-tx experimental:subject_root_name_update carrying the exact version/name transition (YUK-728).',
  },
  {
    table: 'knowledge',
    file: 'src/capabilities/practice/server/question-supply/placement-starter-store.ts',
    marker: '.insert(knowledge)',
    role: 'event-native-by-caller',
    note: 'placement starter content-KC mint accepts Tx only and writes same-tx experimental:genesis plus deterministic materialized_id_index anchor.',
  },
  {
    table: 'knowledge',
    file: 'src/capabilities/practice/jobs/embed_backfill.ts',
    marker: '.update(knowledge)',
    role: 'maintenance',
    note: 'embedding backfill rewrites the non-fold `embedding` column only (a search-index side column, not fold-truth identity/state).',
  },

  // ---- knowledge_edge (LIVE) ----
  {
    table: 'knowledge_edge',
    file: 'src/server/projections/knowledge_edge.ts',
    marker: '.insert(knowledge_edge)',
    role: 'throat',
    note: 'projection write-through shell — the fold row writer for knowledge_edge (ADR-0044 W1, LIVE).',
  },
  {
    table: 'knowledge_edge',
    file: 'src/capabilities/knowledge/server/edges.ts',
    marker: '.insert(knowledge_edge)',
    role: 'event-native-by-caller',
    note: 'canonical create/archive/reactivate CRUD has no local projectionIsWriter/event append; every production caller owns a transaction and pairs the row write with fold-visible generate(create|archive). Caller matrix audited in docs/audit/2026-07-19-yuk-587-fold-write-event-nativeness.md.',
  },
  // NOTE: frontier_fill_nightly.ts is NOT a knowledge_edge writer — it is PROPOSE-ONLY (writes
  // `propose` events, never a live row; the file header states "There is NO .insert(knowledge_edge)
  // anywhere below"). The only `.insert(knowledge_edge)` token in it is that comment, which the
  // audit's comment-stripper correctly excludes — so it has zero live write sites and must NOT be
  // declared a sanctioned writer (doing so would be dead config).
  {
    table: 'knowledge_edge',
    file: 'src/capabilities/knowledge/server/edge-proposal-accept.ts',
    marker: 'projectionIsWriter()',
    role: 'gated-dual-path',
    note: 'Create INSERT is gated; same-tx generate event feeds the topology projector. Archive delegates to the separately audited edges owner.',
  },

  // ---- goal (canonical, YUK-973) ----
  {
    table: 'goal',
    file: 'src/server/projections/goal.ts',
    marker: '.insert(goal)',
    role: 'throat',
    note: 'Sole structural row writer; business mutations append events then project in the same transaction.',
  },

  // ---- mistake_variant (canonical, YUK-973) ----
  {
    table: 'mistake_variant',
    file: 'src/server/projections/mistake_variant.ts',
    marker: '.insert(mistake_variant)',
    role: 'throat',
    note: 'Sole structural row writer; business mutations append events then project in the same transaction.',
  },

  // ---- learning_item (canonical, YUK-973) ----
  {
    table: 'learning_item',
    file: 'src/server/projections/learning_item.ts',
    marker: '.insert(learning_item)',
    role: 'throat',
    note: 'Sole structural row writer; business mutations append events then project in the same transaction.',
  },

  // ---- artifact (switchable; actual deployment flags are checked separately) ----
  {
    table: 'artifact',
    file: 'src/server/projections/artifact.ts',
    marker: '.insert(artifact)',
    role: 'throat',
    note: 'Artifact projection write-through shell; activation is runtime-specific.',
  },
  {
    table: 'artifact',
    file: 'src/capabilities/notes/server/note-refine-apply.ts',
    marker: '.update(artifact)',
    role: 'event-native-by-caller',
    note: 'Version-CAS body/history mutation and undo emit self-contained refine events with the exact paired row timestamp in the caller transaction.',
  },
  {
    table: 'artifact',
    file: 'src/capabilities/notes/server/hub-dismiss.ts',
    marker: '.update(artifact)',
    role: 'event-native-by-caller',
    note: 'Suppression attrs and body edits share a transaction; lifecycle set_attrs and refine events carry ordered timestamps and exact after-state.',
  },
  {
    table: 'artifact',
    file: 'src/capabilities/notes/server/sections.ts',
    marker: '.update(artifact)',
    role: 'event-native-by-caller',
    note: 'Section body/history CAS and full body_blocks_edit snapshot share the transaction, version and timestamp.',
  },
  {
    table: 'artifact',
    file: 'src/capabilities/notes/jobs/note_verify.ts',
    marker: '.update(artifact)',
    role: 'event-native-by-caller',
    note: 'Result persistence runs inside claim-result finalization after artifact/claim locks and epoch/status revalidation; lifecycle shares the update timestamp.',
  },
  {
    table: 'artifact',
    file: 'src/capabilities/notes/server/note-verification-claim-reservation.ts',
    marker: '.update(artifact)',
    role: 'event-native-by-caller',
    note: 'Epoch/status-guarded exhaustion update and lifecycle event are atomic with the claim transition.',
  },
  {
    table: 'artifact',
    file: 'src/capabilities/notes/jobs/note_generate.ts',
    marker: '.update(artifact)',
    role: 'event-native-by-caller',
    note: 'Generation status/body updates emit same-tx lifecycle/full body snapshots with exact row timestamps.',
  },
  {
    table: 'artifact',
    file: 'src/capabilities/ingestion/server/make-paper.ts',
    marker: '.insert(artifact)',
    role: 'event-native-by-caller',
    note: 'Paper materialization emits artifact_create from the full returned row in its transaction.',
  },
  {
    table: 'artifact',
    file: 'src/capabilities/practice/jobs/quiz_gen.ts',
    marker: '.insert(artifact)',
    role: 'event-native-by-caller',
    note: 'Quiz artifact INSERT and artifact_create share the generation transaction and timestamp.',
  },
  {
    table: 'artifact',
    file: 'src/capabilities/practice/server/tools/tool-quiz-core.ts',
    marker: '.insert(artifact)',
    role: 'event-native-by-caller',
    note: 'Tx-only quiz writer emits artifact_create from the full RETURNING row with the same timestamp; write_quiz owns the enclosing transaction.',
  },
  {
    table: 'artifact',
    file: 'src/capabilities/notes/server/tools/author-artifact.ts',
    marker: '.insert(artifact)',
    role: 'event-native-by-caller',
    note: 'Tx-owned create snapshot and version-CAS attrs/lifecycle update; invalid event rolls back the paired row mutation.',
  },
  {
    table: 'artifact',
    file: 'src/capabilities/notes/server/learning-intent-note.ts',
    marker: '.insert(artifact)',
    role: 'event-native-by-caller',
    note: 'Tx-only learning-intent materialization emits artifact_create from the returned row with the supplied creation timestamp.',
  },
  {
    table: 'artifact',
    file: 'src/capabilities/ingestion/server/legacy-record-appliers.ts',
    marker: '.insert(artifact)',
    role: 'event-native-by-caller',
    note: 'Record promotion emits artifact_create from the full RETURNING row in the acceptance transaction, chained to its rate event.',
  },
  {
    table: 'artifact',
    file: 'src/capabilities/notes/server/proposal-artifacts.ts',
    marker: '.update(artifact)',
    role: 'event-native-by-caller',
    note: 'Notes owns locked proposal artifact archive and matching lifecycle events; stale correction clocks roll back the whole proposal transaction.',
  },
  {
    table: 'artifact',
    file: 'src/capabilities/notes/server/hub-sync-reconciliation.ts',
    marker: 'update artifact',
    role: 'event-native-by-caller',
    note: 'Fenced hub finalization pairs body/version CAS with a full body_blocks_edit snapshot, exact returned update time and cursor acknowledgement in one transaction.',
  },

  // ---- question_block (switchable; actual deployment flags are checked separately) ----
  {
    table: 'question_block',
    file: 'src/server/projections/question_block.ts',
    marker: '.insert(question_block)',
    role: 'throat',
    note: 'QuestionBlock projection write-through shell; activation is runtime-specific.',
  },
  {
    table: 'question_block',
    file: 'src/capabilities/ingestion/server/auto-enroll.ts',
    marker: '.update(question_block)',
    role: 'event-native-by-caller',
    note: 'Enrollment transaction pairs imported block links/status/version with a lifecycle event using the same timestamp.',
  },
  {
    table: 'question_block',
    file: 'src/capabilities/ingestion/server/revert-auto-enroll.ts',
    marker: '.update(question_block)',
    role: 'event-native-by-caller',
    note: 'Revert transaction pairs restored block status/version with a lifecycle event, preserving nullable import references.',
  },
  {
    table: 'question_block',
    file: 'src/capabilities/ingestion/server/import-completion.ts',
    marker: '.insert(question_block)',
    role: 'event-native-by-caller',
    note: 'Import completion owns one transaction for create snapshots, import-link and ignore-sweep lifecycle events; extracted_prompt_md/ordinal remain explicit non-fold fields.',
  },
  {
    table: 'question_block',
    file: 'src/server/session/docx-ingestion.ts',
    marker: '.insert(question_block)',
    role: 'event-native-by-caller',
    note: 'DOCX session transaction emits create snapshots for inserted blocks; extraction text/ordinal are explicitly outside fold truth.',
  },
  {
    table: 'question_block',
    file: 'src/server/session/ingestion.ts',
    marker: '.insert(question_block)',
    role: 'event-native-by-caller',
    note: 'Extraction create/replacement writes emit full question_block_create snapshots on the caller transaction; extraction text/ordinal are non-fold fields.',
  },
  // ---- item_calibration (YUK-496 方案 A — anchor-only coverage, default OFF, no flip planned) ----
  {
    table: 'item_calibration',
    file: 'src/server/projections/item_calibration.ts',
    marker: '.insert(item_calibration)',
    role: 'throat',
    note: 'projection write-through shell — the fold row writer for item_calibration (default OFF; rebuild:projection / B3 gate only, never a live-path writer under 方案 A).',
  },
  {
    table: 'item_calibration',
    file: 'src/server/mastery/item-calibration.ts',
    marker: '.insert(item_calibration)',
    role: 'off-path-writer',
    note: 'applyItemPrior hard-track INSERT (the B1 cold-start applier the ticket names; OFF-path sole writer — 方案 A keeps it imperative, no flip planned).',
  },
  {
    table: 'item_calibration',
    file: 'src/server/mastery/fixed-anchor.ts',
    marker: '.insert(item_calibration)',
    role: 'off-path-writer',
    note: 'fixed-anchor upsert (INSERT + onConflictDoUpdate; OFF-path sole writer — 方案 A keeps it imperative).',
  },
  {
    table: 'item_calibration',
    file: 'src/server/mastery/kt-calibration.ts',
    marker: '.update(item_calibration)',
    role: 'off-path-writer',
    note: 'applyKtEstimate kt_json UPDATE (OFF-path sole writer — post-anchor writes surface as audit drift, the documented 方案 A boundary).',
  },
  {
    table: 'item_calibration',
    file: 'src/server/mastery/recalibration.ts',
    marker: '.update(item_calibration)',
    role: 'off-path-writer',
    note: 'recalibrateQuestion b_calib firm-up UPDATE (OFF-path sole writer — post-anchor writes surface as audit drift, the documented 方案 A boundary).',
  },
];

// ── comment stripping (char-stepped, escape-aware; KEEPS string content) ──────────────────────
//
// Strips line + block comments so a docstring like "// UPDATE question_block: link…" (import.ts) or
// the projection shells' "DELETE FROM knowledge WHERE id=…" doc lines are NOT mistaken for real
// writes. STRING CONTENT IS KEPT (unlike audit-mastery-provenance's stripper) because a real raw-SQL
// write lives INSIDE a string/template (`sql\`UPDATE knowledge…\``) — stripping strings would blind
// the raw-SQL scan. The Drizzle-form scan is unaffected: `.update(knowledge)` is bare code, never
// inside a string. Escape/quote state is tracked so a `//` inside a string is not treated as a comment.
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  let inLine = false;
  let inBlock = false;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      i += 1;
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false;
        i += 2;
        continue;
      }
      // Preserve newlines inside block comments so reported line numbers stay aligned with the
      // ORIGINAL source (a collapsed multi-line block comment would otherwise shift every write
      // site below it upward).
      if (c === '\n') out += c;
      i += 1;
      continue;
    }
    if (inSingle) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (c === "'") inSingle = false;
      i += 1;
      continue;
    }
    if (inDouble) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inDouble = false;
      i += 1;
      continue;
    }
    if (inTemplate) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (c === '`') inTemplate = false;
      i += 1;
      continue;
    }
    // not in any string/comment.
    if (c === '/' && next === '/') {
      inLine = true;
      i += 2;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlock = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === '`') {
      inTemplate = true;
      out += c;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// ── source walk ────────────────────────────────────────────────────────────────────────────────

export function walkSource(root: string, out: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out; // a scan root that does not exist (e.g. server/ in a stripped checkout) is skipped.
  }
  for (const entry of entries) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    const abs = join(root, entry.name);
    if (entry.isDirectory()) {
      walkSource(abs, out);
    } else if (
      entry.isFile() &&
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
      // Mirror the sibling audits: skip test files (a table write in a *.test.ts fixture is not a
      // production fold mutation) and type declarations.
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.test.tsx') &&
      !entry.name.endsWith('.d.ts')
    ) {
      const rel = relative(REPO_ROOT, abs);
      if (!EXCLUDE_FILES.has(rel)) out.push(rel);
    }
  }
  return out;
}

// ── write-site detection ─────────────────────────────────────────────────────────────────────

export type WriteForm = 'drizzle' | 'raw-sql';
export type WriteSite = {
  file: string;
  table: FoldOwnedTable;
  op: 'update' | 'insert' | 'delete';
  form: WriteForm;
  line: number;
};

const TABLE_ALT = FOLD_OWNED_TABLES.join('|');
// Drizzle: `.update(knowledge)` / `.insert(knowledge_edge)` / `.delete(goal)`. The `)` after the
// bare identifier disambiguates knowledge vs knowledge_edge (and goal vs any goal_* table).
const DRIZZLE_RE = new RegExp(`\\.(update|insert|delete)\\(\\s*(${TABLE_ALT})\\s*\\)`, 'g');
// Raw SQL inside a string/template: `UPDATE knowledge`, `DELETE FROM goal`, `INSERT INTO artifact`.
// Optional double-quote around the identifier (`UPDATE "knowledge"`). Case-insensitive keyword.
const RAW_SQL_RE = new RegExp(
  `\\b(UPDATE|DELETE\\s+FROM|INSERT\\s+INTO)\\s+"?(${TABLE_ALT})"?\\b`,
  'gi',
);

const RAW_SQL_OP: Record<string, WriteSite['op']> = {
  UPDATE: 'update',
  DELETE: 'delete',
  INSERT: 'insert',
};

/**
 * Scan the comment-stripped source of each file for fold-owned-table write sites (Drizzle + raw
 * SQL). `readFile` injectable for unit testing. Pure. Line numbers are 1-based (counted on the
 * stripped source, whose newlines are preserved so line numbers stay aligned with the original).
 */
export function findWriteSites(
  files: string[],
  readFile: (relPath: string) => string | null,
): WriteSite[] {
  const sites: WriteSite[] = [];
  for (const file of files) {
    const raw = readFile(file);
    if (raw === null) continue;
    const code = stripComments(raw);
    // pre-compute line offsets on the stripped source (newlines preserved by the stripper).
    const lineAt = (index: number): number => {
      let line = 1;
      for (let k = 0; k < index && k < code.length; k += 1) {
        if (code[k] === '\n') line += 1;
      }
      return line;
    };
    DRIZZLE_RE.lastIndex = 0;
    for (const m of code.matchAll(DRIZZLE_RE)) {
      sites.push({
        file,
        table: m[2] as FoldOwnedTable,
        op: m[1] as WriteSite['op'],
        form: 'drizzle',
        line: lineAt(m.index ?? 0),
      });
    }
    RAW_SQL_RE.lastIndex = 0;
    for (const m of code.matchAll(RAW_SQL_RE)) {
      const kw = m[1].toUpperCase().split(/\s+/)[0];
      sites.push({
        file,
        table: m[2] as FoldOwnedTable,
        op: RAW_SQL_OP[kw] ?? 'update',
        form: 'raw-sql',
        line: lineAt(m.index ?? 0),
      });
    }
  }
  return sites;
}

// ── registry reverse-check (STALE detection) ───────────────────────────────────────────────────

export type StaleWriter = SanctionedWriter & { problem: 'file-missing' | 'marker-missing' };

/**
 * Reverse-check every declared sanctioned writer: its file must exist AND its marker must still
 * appear in that file (marker match runs on the RAW source, so a marker that is legitimately a
 * comment token still counts — the reverse-check only asks "is this file still the writer it
 * claims to be"). `readFile` injectable. Pure.
 */
export function reverseCheckWriters(
  registry: SanctionedWriter[],
  readFile: (relPath: string) => string | null,
): StaleWriter[] {
  const stale: StaleWriter[] = [];
  const cache = new Map<string, string | null>();
  const read = (f: string): string | null => {
    if (!cache.has(f)) cache.set(f, readFile(f));
    return cache.get(f) ?? null;
  };
  for (const entry of registry) {
    const src = read(entry.file);
    if (src === null) {
      stale.push({ ...entry, problem: 'file-missing' });
      continue;
    }
    if (!src.includes(entry.marker)) {
      stale.push({ ...entry, problem: 'marker-missing' });
    }
  }
  return stale;
}

// ── allowlist contract (mirrors audit:schema / audit:mastery-provenance resolves_when) ──────────

export type ResolvesWhen = { kind: 'pr' | 'phase' | 'manual'; ref: string; expected_by: string };
export type AllowlistEntry = { reason: string; resolves_when: ResolvesWhen };
/** allowlist key = `<table>::<file>` (a write site is allowlisted per table-file pair). */
export type Allowlist = Record<string, AllowlistEntry>;

export type AllowlistProblem = { key: string; detail: string };

export function validateAllowlistEntry(
  key: string,
  entry: AllowlistEntry,
  today: string,
): AllowlistProblem[] {
  const problems: AllowlistProblem[] = [];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return [{ key, detail: 'allowlist entry must be an object with reason/resolves_when' }];
  }
  if (typeof entry.reason !== 'string' || entry.reason.trim().length === 0) {
    problems.push({ key, detail: 'reason must be a non-empty string' });
  }
  const rw = entry.resolves_when;
  if (rw === null || typeof rw !== 'object') {
    problems.push({ key, detail: 'resolves_when must be { kind, ref, expected_by }' });
    return problems;
  }
  if (rw.kind !== 'pr' && rw.kind !== 'phase' && rw.kind !== 'manual') {
    problems.push({ key, detail: "resolves_when.kind must be 'pr', 'phase', or 'manual'" });
  }
  if (typeof rw.ref !== 'string' || rw.ref.trim().length === 0) {
    problems.push({ key, detail: 'resolves_when.ref must be non-empty' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rw.expected_by)) {
    problems.push({ key, detail: 'resolves_when.expected_by must be YYYY-MM-DD' });
  } else if (Number.isNaN(Date.parse(rw.expected_by))) {
    problems.push({
      key,
      detail: `resolves_when.expected_by ${rw.expected_by} is not a valid date`,
    });
  } else if (rw.expected_by < today) {
    problems.push({
      key,
      detail: `resolves_when.expected_by ${rw.expected_by} is before ${today}`,
    });
  }
  return problems;
}

// ── audit verdict ────────────────────────────────────────────────────────────────────────────

export type SiteStatus = 'sanctioned' | 'allowlisted' | 'violation';
export type SiteVerdict = WriteSite & { status: SiteStatus; role?: WriterRole };

// A writer with one of these roles is locally constrained not to bypass fold truth:
// throat/reducer IS the fold path; gated-dual-path locally defers to it when ON; maintenance only
// touches fold-excluded derived columns. Every other role defaults to ADVISORY. This negative
// classification means a future special role cannot silently disappear merely because someone forgot
// to extend a hard-coded advisory allow-list (the YUK-587 gap that hid proposals.ts + seed.ts).
const LOCALLY_CONSTRAINED_ROLES: ReadonlySet<WriterRole> = new Set([
  'throat',
  'reducer',
  'gated-dual-path',
  'maintenance',
]);

/** Canonical or switchable writers whose fold visibility depends on an event-native contract. */
export function collectWriterAdvisories(verdicts: readonly SiteVerdict[]): SiteVerdict[] {
  return verdicts.filter(
    (v) =>
      v.status === 'sanctioned' &&
      FOLD_WRITE_POLICY[v.table] !== 'anchor-only' &&
      v.role !== undefined &&
      !LOCALLY_CONSTRAINED_ROLES.has(v.role),
  );
}

export type FoldWriteAuditResult = {
  verdicts: SiteVerdict[];
  violations: SiteVerdict[];
  /** Report-only canonical/switchable writers whose event-native invariant needs owner review. */
  advisories: SiteVerdict[];
  stale: StaleWriter[];
  allowlistProblems: AllowlistProblem[];
  /** allowlist keys that match no live write site (dead config → drift). */
  redundantAllowlist: string[];
  /** true iff no violations, no stale registry entries, no allowlist problems, no dead allowlist. */
  ok: boolean;
};

function allowlistKey(table: FoldOwnedTable, file: string): string {
  return `${table}::${file}`;
}

/**
 * Core audit: classify each write site as sanctioned (its file is a declared writer of that table,
 * and that entry is NOT stale) / allowlisted / violation. Exported pure for unit testing.
 */
export function computeFoldWriteAudit(
  sites: WriteSite[],
  registry: SanctionedWriter[],
  stale: StaleWriter[],
  allowlist: Allowlist,
  today: string,
): FoldWriteAuditResult {
  const staleKeys = new Set(stale.map((s) => `${s.table}|${s.file}|${s.marker}`));
  // A (table,file) is a live sanctioned writer iff it has at least one NON-stale registry entry.
  const sanctionedPairs = new Map<string, WriterRole>();
  for (const w of registry) {
    if (staleKeys.has(`${w.table}|${w.file}|${w.marker}`)) continue;
    sanctionedPairs.set(`${w.table}::${w.file}`, w.role);
  }

  const verdicts: SiteVerdict[] = [];
  const violations: SiteVerdict[] = [];
  const usedAllowlistKeys = new Set<string>();
  const allowlistProblems: AllowlistProblem[] = [];

  for (const site of sites) {
    const pairKey = `${site.table}::${site.file}`;
    const alKey = allowlistKey(site.table, site.file);
    if (sanctionedPairs.has(pairKey)) {
      verdicts.push({ ...site, status: 'sanctioned', role: sanctionedPairs.get(pairKey) });
      continue;
    }
    if (Object.hasOwn(allowlist, alKey)) {
      verdicts.push({ ...site, status: 'allowlisted' });
      if (!usedAllowlistKeys.has(alKey)) {
        usedAllowlistKeys.add(alKey);
        allowlistProblems.push(...validateAllowlistEntry(alKey, allowlist[alKey], today));
      }
      continue;
    }
    const v: SiteVerdict = { ...site, status: 'violation' };
    verdicts.push(v);
    violations.push(v);
  }

  // Reverse check: an allowlist key that matched no live write site is dead config.
  const redundantAllowlist: string[] = [];
  for (const key of Object.keys(allowlist)) {
    if (!usedAllowlistKeys.has(key)) redundantAllowlist.push(key);
  }

  return {
    verdicts,
    violations,
    advisories: collectWriterAdvisories(verdicts),
    stale,
    allowlistProblems,
    redundantAllowlist,
    ok:
      violations.length === 0 &&
      stale.length === 0 &&
      allowlistProblems.length === 0 &&
      redundantAllowlist.length === 0,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────

function readFileOrNull(relPath: string): string | null {
  try {
    return readFileSync(join(REPO_ROOT, relPath), 'utf-8');
  } catch {
    return null;
  }
}

function loadAllowlist(): Allowlist {
  try {
    const parsed: unknown = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf-8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error(
        `[audit:fold-writes] allowlist at ${ALLOWLIST_PATH} has a non-object root; treating as empty`,
      );
      return {};
    }
    return parsed as Allowlist;
  } catch (err) {
    console.error(
      `[audit:fold-writes] failed to load allowlist at ${ALLOWLIST_PATH}; treating as empty:`,
      err instanceof Error ? err.message : err,
    );
    return {};
  }
}

/** Shared repository inventory for the CLI and existing table-ownership test gates. */
export function auditFoldWrites(): FoldWriteAuditResult {
  const today = new Date().toISOString().slice(0, 10);

  const files: string[] = [];
  for (const root of SCAN_ROOTS) walkSource(join(REPO_ROOT, root), files);
  files.sort();

  const sites = findWriteSites(files, readFileOrNull);
  const stale = reverseCheckWriters(SANCTIONED_WRITERS, readFileOrNull);
  return computeFoldWriteAudit(sites, SANCTIONED_WRITERS, stale, loadAllowlist(), today);
}

function main(): void {
  const isJson = process.argv.includes('--json');
  const isStrict = process.argv.includes('--strict');
  const result = auditFoldWrites();

  if (isJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('audit:fold-writes — fold-owned 表 raw-write 反向审计 (红线审查 wave F / A4)\n');

    // role breakdown of sanctioned sites (per table).
    const roleByTable = new Map<FoldOwnedTable, Map<WriterRole, number>>();
    for (const v of result.verdicts) {
      if (v.status !== 'sanctioned' || !v.role) continue;
      if (!roleByTable.has(v.table)) roleByTable.set(v.table, new Map());
      const m = roleByTable.get(v.table);
      if (m) m.set(v.role, (m.get(v.role) ?? 0) + 1);
    }
    console.log('  sanctioned write sites per fold-owned table (role → count):');
    for (const table of FOLD_OWNED_TABLES) {
      const policy = FOLD_WRITE_POLICY[table];
      const m = roleByTable.get(table);
      const roles = m ? [...m.entries()].map(([r, c]) => `${r}×${c}`).join(', ') : '(no sites)';
      console.log(`    [${policy}] ${table.padEnd(16)} ${roles}`);
    }
    console.log('');

    if (result.violations.length === 0) {
      console.log(
        '  VIOLATIONS (raw write in a file not declared as a sanctioned writer):  (none)',
      );
    } else {
      console.log(
        `  VIOLATIONS (raw write in a file not declared as a sanctioned writer):  ${result.violations.length}`,
      );
      for (const v of result.violations) {
        console.log(
          `    - ${v.file}:${v.line}  .${v.op}(${v.table}) [${FOLD_WRITE_POLICY[v.table]}]  (${v.form})`,
        );
      }
      console.log(
        '\n  Fix: route the write through the projection shell (src/server/projections/<table>.ts) or an\n' +
          '  event-native, projectionIsWriter-gated applier — OR, if it is a legitimate new writer, add it to\n' +
          '  scripts/audit-fold-writes.ts SANCTIONED_WRITERS with a role + marker, or to the allowlist with a\n' +
          '  reason + resolves_when.',
      );
    }
    console.log('');

    // Negative classification is computed in the result so --json and text share exact coverage.
    if (result.advisories.length > 0) {
      console.log(
        `  ADVISORY — canonical/switchable row writers needing event-native verification (not live deployment telemetry):  ${result.advisories.length}`,
      );
      for (const v of result.advisories) {
        console.log(`    - ${v.file}:${v.line}  .${v.op}(${v.table})  [${v.role}]`);
      }
      console.log('');
    }

    if (result.stale.length > 0) {
      console.log(
        `  STALE-REGISTRY (declared writer whose marker no longer matches):  ${result.stale.length}`,
      );
      for (const s of result.stale) {
        console.log(
          `    - ${s.table} / ${s.file} — ${s.problem} (marker: ${JSON.stringify(s.marker)})`,
        );
      }
      console.log(
        '\n  Fix: the writer moved/renamed. Update SANCTIONED_WRITERS (file/marker), or drop the entry if the\n' +
          '  writer was genuinely removed.',
      );
      console.log('');
    }

    if (result.redundantAllowlist.length > 0) {
      console.log(
        `  REDUNDANT allowlist entries (match no live write site):  ${result.redundantAllowlist.length}`,
      );
      for (const k of result.redundantAllowlist) console.log(`    - ${k}: drop from allowlist.`);
      console.log('');
    }

    if (result.allowlistProblems.length > 0) {
      console.log(`  ALLOWLIST problems:  ${result.allowlistProblems.length}`);
      for (const p of result.allowlistProblems) console.log(`    - ${p.key}: ${p.detail}`);
      console.log('');
    }

    console.log(
      '  A4 event-sourcing 咽喉红线：fold-owned 表禁绕过咽喉的 raw 写. report-only (exit 0); --strict opts\n' +
        '  into a CI gate. A first-run VIOLATION means a NEW writer bypasses the throat — the kc-dedup 缺口\n' +
        '  (knowledge_edge raw UPDATE invisible to fold, active in prod for weeks) is exactly what this guards.',
    );
  }

  if (isStrict && !result.ok) process.exit(1);
}

// CLI-gate (mirrors audit-relations.ts): only run + exit when invoked as a CLI so the self-test can
// import the pure functions without the top-level scan firing.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
