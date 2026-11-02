/**
 * audit:relations — KG 死边反向审计
 *
 * A relation type is a "dead edge" when rows are created, proposed, or persisted but no
 * diagnosis / recommendation / review path reads it by type to change behavior. The graph grows
 * without affecting learning. Creation-time validation does not count; generic reads that dump
 * every type at a consumer do not count either. Only type-specific (specialized) consumption does.
 *
 * The consumer registry is hand-maintained. Each entry names a file and a grep marker; this audit
 * reverse-checks that the marker still exists, so a deleted or renamed consumer reports STALE
 * instead of quietly keeping the type "alive".
 *
 * Default is report-only. `--strict` exits non-zero on a dead type or a stale declaration; whether
 * to wire that into the test chain is an owner decision.
 *
 * Limitation: the registry only catches declared paths that vanished. It cannot discover a new
 * type-specific consumer that was never declared.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANONICAL_MISCONCEPTION_RELATIONS } from '@/core/schema/misconception-edge';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SRC_ROOT = join(REPO_ROOT, 'src');

const EXCLUDE_DIRS = new Set(['node_modules', '.next', 'dist', '.git', '.claude', 'drizzle']);

// The 5 core relation types (ADR-0010, matching CoreRelationType). experimental:* is an escape
// namespace for unproven types; it is reported for observability but not audited as a dead edge,
// because lacking consumers there is expected while it is still exploratory.
export const CORE_RELATION_TYPES = [
  'prerequisite',
  'related_to',
  'contrasts_with',
  'applied_in',
  'derived_from',
] as const;
export type CoreRelationType = (typeof CORE_RELATION_TYPES)[number];

// Heterogeneous misconception_edge relation universe (ADR-0036), separate from the homogeneous
// knowledge_edge set above. Import the vocabulary from the schema as the single source of truth so
// the audit cannot drift. Run as its own verdict pass; the knowledge_edge shape stays unchanged.
export const MISCONCEPTION_RELATION_TYPES = CANONICAL_MISCONCEPTION_RELATIONS;
export type MisconceptionRelationType = (typeof MISCONCEPTION_RELATION_TYPES)[number];

/** Any relation_type the dead-edge audit reasons over (knowledge_edge ∪ misconception_edge). */
export type AuditRelationType = CoreRelationType | MisconceptionRelationType;

// ---------- consumption tiers ----------

export type ConsumerTier = 'creation-validation' | 'generic-read' | 'specialized';

/**
 * How specifically a downstream path consumes an edge type. Only `specialized` keeps a type
 * alive: it branches on the relation type and changes learning behavior.
 */
export const TIER_RANK: Record<ConsumerTier, number> = {
  'creation-validation': 0,
  'generic-read': 1,
  specialized: 2,
};

/**
 * One declared consumer path: relation type, source file, grep marker for the reverse-check,
 * consumption tier, learning surface, and a one-line evidence note.
 */
export type ConsumerEntry = {
  relation: AuditRelationType;
  tier: ConsumerTier;
  /** repo-relative source file that consumes this edge type. */
  file: string;
  /** literal substring that MUST still appear in `file` (drift reverse-check). */
  marker: string;
  /** which learning surface: diagnosis / recommendation / review / validation. */
  surface: 'diagnosis' | 'recommendation' | 'review' | 'validation';
  evidence: string;
};

// ── CONSUMER_REGISTRY — hand-maintained; each entry carries its own file:marker evidence ─────
const CONSUMER_REGISTRY: ConsumerEntry[] = [
  // ---- generic-read: copilot 邻域/路径一把灌（覆盖全 5 core type）----
  ...CORE_RELATION_TYPES.map(
    (relation): ConsumerEntry => ({
      relation,
      tier: 'generic-read',
      file: 'src/capabilities/knowledge/server/tools/knowledge-readers.ts',
      // loadEdges 无 relationTypes 时不过滤 ⇒ 所有 type 都被灌进 neighborhood/paths。
      marker: 'async function loadEdges',
      surface: 'recommendation',
      evidence:
        'get_knowledge_neighborhood / find_knowledge_paths 经 loadEdges() 把所有 relation_type 一把灌给 copilot 诊断/推荐上下文（无 type 过滤，非差异化）。',
    }),
  ),

  // ---- specialized: prerequisite ----
  {
    relation: 'prerequisite',
    tier: 'specialized',
    file: 'src/core/topology-gate.ts',
    marker: "const ORDERED_RELATION = 'prerequisite'",
    surface: 'diagnosis',
    evidence:
      'topology-gate 环检测/传递冗余仅对 prerequisite 边运行（ORDERED_RELATION），驱动结构一致性诊断。',
  },
  {
    relation: 'prerequisite',
    tier: 'specialized',
    file: 'src/capabilities/notes/server/hub-curation.ts',
    marker: "'prerequisite'",
    surface: 'review',
    evidence:
      'hub-mesh 笔记自动同步按 prerequisite 边（incoming）组装「这是 X 的前置」复习上下文（RELATION_PRIORITY）。',
  },
  {
    // YUK-455 grounding — learnable_frontier (B3, PR #635) 的 prerequisite specialized 消费在
    // 原 PR 遗漏登记；inc-E 顺手补上（否则该 type-specific 消费路径不在反查覆盖内）。
    relation: 'prerequisite',
    tier: 'specialized',
    file: 'src/kernel/read-models/learnable-frontier.ts',
    marker: "e.relation_type = 'prerequisite'",
    surface: 'recommendation',
    evidence:
      'learnable_frontier (B3) 沿 prerequisite 边向上闭包 gate「可学前沿」候选（self 未掌握 ∧ 全 transitive 前置已掌握），按 type 驱动每日流 5th 候选源选题推荐。',
  },

  // ---- specialized: contrasts_with ----
  {
    relation: 'contrasts_with',
    tier: 'specialized',
    file: 'src/capabilities/notes/server/hub-curation.ts',
    marker: "'contrasts_with'",
    surface: 'review',
    evidence:
      'hub-mesh 按 contrasts_with 边组装「对比」复习上下文（RELATION_PRIORITY，对照辨析）。',
  },
  {
    relation: 'contrasts_with',
    tier: 'specialized',
    file: 'src/capabilities/knowledge/server/tools/knowledge-readers.ts',
    marker: "edge.relation_type === 'contrasts_with'",
    surface: 'recommendation',
    evidence: 'find_knowledge_paths 对 contrasts_with 加反向邻接（双向语义），影响路径推荐结果。',
  },

  // ---- specialized: derived_from ----
  {
    relation: 'derived_from',
    tier: 'specialized',
    file: 'src/capabilities/notes/server/hub-curation.ts',
    marker: "'derived_from'",
    surface: 'review',
    evidence:
      'hub-mesh 按 derived_from 边（to ∈ hub）组装「派生自」复习上下文（RELATION_PRIORITY）。',
  },

  // ---- specialized: related_to ----
  {
    relation: 'related_to',
    tier: 'specialized',
    file: 'src/capabilities/knowledge/server/tools/knowledge-readers.ts',
    marker: "edge.relation_type === 'related_to'",
    surface: 'recommendation',
    evidence: 'find_knowledge_paths 对 related_to 加反向邻接（双向语义），影响路径推荐结果。',
  },

  // ---- specialized: A5/A6 (YUK-441/442) mastery-projection KG soft layer ----
  // getMasteryProjection (src/kernel/read-models/mastery-projection.ts) branches on relation_type to
  // feed the per-KC ability θ̂ soft layer: related_to → A5 graph-Laplacian symmetric
  // smoothing; prerequisite / derived_from → A6 directed order prior. dark-ship
  // (GRAPH_LAPLACIAN_ENABLED / PREREQ_PROPAGATION_ENABLED default false) but the
  // branch is wired in source, so the type-specific consumption is LIVE-in-code.
  {
    relation: 'related_to',
    tier: 'specialized',
    file: 'src/kernel/read-models/mastery-projection.ts',
    marker: "r.relation_type === 'related_to'",
    surface: 'diagnosis',
    evidence:
      'A5 (YUK-441) — getMasteryProjection smooths per-KC θ̂ along symmetric related_to edges (graph-Laplacian GMRF prior); unobserved KCs borrow from observed neighbours.',
  },
  {
    relation: 'prerequisite',
    tier: 'specialized',
    file: 'src/kernel/read-models/mastery-projection.ts',
    marker: "r.relation_type === 'prerequisite'",
    surface: 'diagnosis',
    evidence:
      'A6 (YUK-442) — getMasteryProjection applies a directed soft order prior along prerequisite edges (press weak-prereq dependents down, retro-credit prereqs of mastered dependents up).',
  },
  {
    relation: 'derived_from',
    tier: 'specialized',
    file: 'src/kernel/read-models/mastery-projection.ts',
    marker: "r.relation_type === 'derived_from'",
    surface: 'diagnosis',
    evidence:
      'A6 (YUK-442) — getMasteryProjection treats derived_from as directed inheritance (base `to` is prereq-like of derived `from`) in the same order-prior propagation.',
  },

  // ---- creation-validation: 全 5 type 的提议时校验闸（非下游学习消费）----
  ...CORE_RELATION_TYPES.map(
    (relation): ConsumerEntry => ({
      relation,
      tier: 'creation-validation',
      file: 'src/capabilities/knowledge/server/rubric-validator.ts',
      marker: 'function relationGate',
      surface: 'validation',
      evidence:
        'rubric-validator relationGate() 在边提议时按 relation_type 分支校验接受/拒绝（创建期，非建好后影响学习）。',
    }),
  ),

  // NOTE: applied_in 故意**无** specialized 条目——这是预期的死边候选。grounding：
  //   src/capabilities/notes/server/hub-curation.ts:35 EXCLUDED_RELATIONS 显式排除 applied_in；topology-gate 仅
  //   prerequisite；knowledge-readers paths 反向邻接仅 related_to/contrasts_with。
  //   applied_in 只被 generic-read 一把捞 + creation-validation 校验，零特化学习消费。
];

// ── MISCONCEPTION_CONSUMER_REGISTRY — same declarative file:marker shape for misconception_edge ──
//
// caused_by and confusable_with have type-specific readers. observed_in has none: it is a
// provenance evidence pointer, so it is this universe's intentional dead-edge candidate (like
// applied_in above).
const MISCONCEPTION_CONSUMER_REGISTRY: ConsumerEntry[] = [
  {
    relation: 'caused_by',
    tier: 'specialized',
    file: 'src/capabilities/knowledge/server/misconception-read.ts',
    marker: "eq(misconception_edge.relation_type, 'caused_by')",
    surface: 'review',
    evidence:
      'misconception-read loadConfirmed joins active misconceptions to a KC via the caused_by edge (relation_type-specific) → 驱动 per-KC「指向此点的误区」funnel (A5 知识浏览器)。',
  },
  {
    relation: 'confusable_with',
    tier: 'specialized',
    file: 'src/kernel/read-models/confusables.ts',
    marker: "eq(misconception_edge.relation_type, 'confusable_with')",
    surface: 'recommendation',
    evidence:
      'misconception-confusable-read loadConfusablePairs reads confusable_with 边 by type → confusable-contrast-discovery 发对比题供给目标（dark-ship CONFUSABLE_CONTRAST_ENABLED 默认 OFF，但 type-specific 读 wired-in-source = LIVE-in-code，同 A5/A6 mastery-projection dark-ship 先例）。',
  },
  // observed_in：故意无 specialized 条目（provenance evidence-ptr，零 type-differentiated
  // 学习消费）→ misconception 宇宙的预期死边候选（类比 applied_in）。
];

// ---------- source walk + reverse-check ----------

export function walkSource(root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    const abs = join(root, entry.name);
    if (entry.isDirectory()) {
      walkSource(abs, out);
    } else if (
      entry.isFile() &&
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
      // Skip tests so a relation type that exists only in a fixture cannot look wired in source.
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.test.tsx') &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(relative(REPO_ROOT, abs));
    }
  }
  return out;
}

/** A declared consumer path whose file is missing or whose marker no longer matches. */
export type StaleConsumer = ConsumerEntry & { problem: 'file-missing' | 'marker-missing' };

/**
 * Reverse-check every declared consumer: its file must exist and its marker must still appear.
 * Returns the stale entries (registry ↔ code drift). `readFile` is injectable. Pure.
 */
export function reverseCheckConsumers(
  registry: ConsumerEntry[],
  readFile: (relPath: string) => string | null,
): StaleConsumer[] {
  const stale: StaleConsumer[] = [];
  // Cache file reads (many entries share a file).
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

// ---------- dead-edge verdict ----------

export type RelationVerdict = {
  relation: AuditRelationType;
  /** highest LIVE consumer tier (stale entries excluded). */
  maxTier: ConsumerTier | 'none';
  /** true when no LIVE specialized consumer exists ⇒ graph spins without learning impact. */
  dead: boolean;
  /** live consumers grouped by tier, for the report. */
  consumers: ConsumerEntry[];
};

export type DeadEdgeResult = {
  /** true when there are no dead edges AND no stale consumer declarations. */
  ok: boolean;
  verdicts: RelationVerdict[];
  dead: AuditRelationType[];
  stale: StaleConsumer[];
};

/**
 * Core verdict: per relation type, the highest LIVE consumer tier. Stale declarations are
 * dropped, so a declared-but-vanished consumer does not keep a type alive. A type is dead when it
 * has no live specialized consumer. `relationTypes` is the universe to render. Pure.
 */
export function computeDeadEdges(
  registry: ConsumerEntry[],
  stale: StaleConsumer[],
  relationTypes: readonly AuditRelationType[] = CORE_RELATION_TYPES,
): DeadEdgeResult {
  const staleKeys = new Set(stale.map((s) => `${s.relation}|${s.tier}|${s.file}|${s.marker}`));
  const live = registry.filter(
    (e) => !staleKeys.has(`${e.relation}|${e.tier}|${e.file}|${e.marker}`),
  );

  const verdicts: RelationVerdict[] = relationTypes.map((relation) => {
    const consumers = live.filter((e) => e.relation === relation);
    const maxTier =
      consumers.length === 0
        ? ('none' as const)
        : consumers.reduce<ConsumerTier>((best, e) => {
            return TIER_RANK[e.tier] > TIER_RANK[best] ? e.tier : best;
          }, consumers[0].tier);
    const dead = !consumers.some((e) => e.tier === 'specialized');
    return { relation, maxTier, dead, consumers };
  });

  const dead = verdicts.filter((v) => v.dead).map((v) => v.relation);
  return {
    ok: dead.length === 0 && stale.length === 0,
    verdicts,
    dead,
    stale,
  };
}

/** Per-universe audit result + the combined stale list (for the shared drift report). */
export type UniverseAudit = {
  knowledge: DeadEdgeResult;
  misconception: DeadEdgeResult;
  /** knowledge ∪ misconception stale (for the single drift section in the report). */
  stale: StaleConsumer[];
};

/**
 * Run the audit over both universes with per-universe stale scoping. Stale must be checked per
 * registry: a combined list would let a stale marker in one universe drag the other's `ok` to
 * false. Pure.
 */
export function auditBothUniverses(
  knowledgeRegistry: ConsumerEntry[],
  misconceptionRegistry: ConsumerEntry[],
  readFile: (relPath: string) => string | null,
): UniverseAudit {
  const knowledgeStale = reverseCheckConsumers(knowledgeRegistry, readFile);
  const misconceptionStale = reverseCheckConsumers(misconceptionRegistry, readFile);
  return {
    knowledge: computeDeadEdges(knowledgeRegistry, knowledgeStale, CORE_RELATION_TYPES),
    misconception: computeDeadEdges(
      misconceptionRegistry,
      misconceptionStale,
      MISCONCEPTION_RELATION_TYPES,
    ),
    stale: [...knowledgeStale, ...misconceptionStale],
  };
}

/**
 * Scan source for `experimental:*` relation types actually wired in. Observability only: these
 * are exempt from the dead-edge gate by design.
 *
 * `experimental:` is shared by relation types and event names, so a flat scan would drown in
 * event names. Count a literal only when its line also has a relation_type context. This is a
 * heuristic: it can miss a relation declared far from any relation_type token.
 */
export function findExperimentalRelations(
  files: string[],
  readFile: (f: string) => string,
): string[] {
  const found = new Set<string>();
  const re = /['"`](experimental:[A-Za-z0-9_:-]+)['"`]/g;
  for (const file of files) {
    const src = readFile(file);
    if (!src.includes('experimental:')) continue;
    // Count the literal only when its line names a relation_type context, to drop event names.
    for (const line of src.split('\n')) {
      if (!line.includes('experimental:')) continue;
      if (!/relation_type|relationType|RelationType/.test(line)) continue;
      for (const m of line.matchAll(re)) found.add(m[1]);
    }
  }
  return [...found].sort();
}

// ---------- CLI ----------

function readFileOrNull(relPath: string): string | null {
  try {
    return readFileSync(join(REPO_ROOT, relPath), 'utf-8');
  } catch {
    return null;
  }
}

/** Print the per-relation verdict table + dead-edge section for one universe (non-JSON). */
function printUniverse(label: string, result: DeadEdgeResult): void {
  console.log(`  ${label} — consumption tier per relation_type (highest LIVE tier):\n`);
  for (const v of result.verdicts) {
    const tag = v.dead ? 'DEAD' : 'live';
    const surfaces = [...new Set(v.consumers.map((c) => c.surface))].join(', ') || '—';
    console.log(
      `  [${tag}] ${v.relation.padEnd(15)} maxTier=${v.maxTier.padEnd(20)} surfaces=${surfaces}`,
    );
    for (const c of v.consumers) {
      console.log(`           · ${c.tier.padEnd(20)} ${c.file}  (${c.surface})`);
    }
  }
  console.log('');

  if (result.dead.length === 0) {
    console.log(`  ${label} DEAD edges (no specialized downstream consumer):  (none)`);
  } else {
    console.log(
      `  ${label} DEAD edges (no specialized downstream consumer):  ${result.dead.length}`,
    );
    for (const r of result.dead) {
      console.log(
        `    - ${r}: created/proposed/persisted but no diagnosis/recommendation/review path reads it by type → graph spins without affecting learning.`,
      );
    }
  }
  console.log('');
}

function main(): void {
  // Stale is per registry; the combined list only feeds the shared drift-report section.
  const {
    knowledge: knowledgeResult,
    misconception: misconceptionResult,
    stale,
  } = auditBothUniverses(CONSUMER_REGISTRY, MISCONCEPTION_CONSUMER_REGISTRY, readFileOrNull);

  const files = walkSource(SRC_ROOT).sort();
  const experimental = findExperimentalRelations(files, (f) => readFileOrNull(f) ?? '');

  const isJson = process.argv.includes('--json');
  const isStrict = process.argv.includes('--strict');

  if (isJson) {
    console.log(
      JSON.stringify(
        { knowledge: knowledgeResult, misconception: misconceptionResult, experimental },
        null,
        2,
      ),
    );
  } else {
    console.log('audit:relations — KG 死边反向审计 (YUK-357 / YUK-533)\n');
    printUniverse('knowledge_edge', knowledgeResult);
    printUniverse('misconception_edge', misconceptionResult);

    if (experimental.length > 0) {
      console.log(
        `  experimental:* relations wired in source (gate-exempt): ${experimental.join(', ')}\n`,
      );
    }

    if (stale.length > 0) {
      console.log(`STALE consumer declarations (registry ↔ code drift):  ${stale.length}`);
      for (const s of stale) {
        console.log(
          `  - ${s.relation} / ${s.tier}: ${s.file} — ${s.problem} (marker: ${JSON.stringify(s.marker)})`,
        );
      }
      console.log(
        '\nFix: the consumer code moved/renamed. Update scripts/audit-relations.ts ' +
          'CONSUMER_REGISTRY (file/marker) to track the real consumption path, or drop ' +
          'the entry if the consumer was genuinely removed (which may turn an edge DEAD).',
      );
      console.log('');
    }

    console.log(
      'GPT §10.1「只保留能影响诊断/推荐/复习的关系」. A dead edge type is a governance ' +
        'signal: either wire a specialized consumer (make it affect learning), stop ' +
        'proposing it, or accept it as intentionally generic-only and record the rationale.',
    );
  }

  // Default report-only; --strict opts into a CI gate.
  if (isStrict && !(knowledgeResult.ok && misconceptionResult.ok)) process.exit(1);
}

// CLI-gate: only run when invoked directly, so importing the pure functions scans nothing.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
