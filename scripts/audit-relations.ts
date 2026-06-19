/**
 * audit:relations — KG 死边反向审计 (YUK-357 / RT4)
 *
 * 决策来源：docs/design/2026-06-14-gpt-doc-gap-analysis.md 决策 7（第 105 行）+
 * docs/design/2026-06-15-rethink-implementation-gate.md §1.7 7c。GPT §10.1 原则
 * 「只保留能影响诊断/推荐/复习的关系」——rethink 只对单条边治理（confusable_with
 * 死边），缺「边创建后是否真被下游消费」的反向审计。本脚本补这一维度。
 *
 * 「死边」定义：一个 relation_type 的边被造出来（提议 / accept / 持久化），但
 * 下游没有任何**特化学习消费路径**（诊断 / 推荐 / 复习）读它、按它的类型驱动
 * 行为。图在转、边在长，但不影响学习——这就是 GPT §10.1 要剪掉的「死关系」。
 *
 * ── 三层消费分级（按 GPT §10.1 的辨别力，从弱到强）──────────────────────
 *
 *   creation-validation  边**提议时**的校验闸（按 relation_type 分支做接受/拒绝
 *                        判断）。这是「该不该建这条边」，不是「建好的边影响不影响
 *                        学习」——GPT §10.1 明确区分二者，故 NOT 算下游学习消费。
 *                        证据：rubric-validator.ts relationGate() 5 路 case。
 *
 *   generic-read         泛化读：把**所有**类型的边不分 type 一把灌给消费者（典型
 *                        是 AI copilot 的邻域/路径工具）。每个核心类型都有这层，
 *                        但它不按 type 驱动差异化行为——是最弱的「活着」信号。
 *                        证据：knowledge-readers.ts loadEdges() 无 relationTypes 过滤。
 *
 *   specialized          特化学习消费：诊断/推荐/复习代码里**按具体 relation_type
 *                        分支**驱动差异化行为（如 prerequisite 驱动拓扑环检测、
 *                        hub-mesh 按 prerequisite/derived_from/contrasts_with 组装
 *                        笔记上下文）。这是 GPT §10.1 要保的「能影响学习」的关系。
 *
 *   ⇒ 「死边」= 某 relation_type **零 specialized 消费**（只被 generic-read 一把
 *      捞起 / 只在 creation-validation 被校验）。它在图里存在但不差异化影响学习。
 *
 * ── 反查机制（防 registry 漂移）────────────────────────────────────────
 *
 * 消费矩阵是**手维护的声明式 registry**（CONSUMER_REGISTRY），每条消费路径带
 * file + grep-marker 证据。脚本对每条声明做**源码反查**：marker 在 file 里仍命中
 * 才算「消费路径还活着」。若某消费路径的 file 不存在或 marker 不再命中（消费代码
 * 被删/改名），脚本报 STALE——registry 与实现漂移被抓到，避免「以为某 type 有消费
 * 其实代码早删了」的假阳性。这与 sibling audit（audit-schema / audit-draft-status）
 * 的「声明 + 反查」治理形态同构。
 *
 * 用法：
 *   pnpm audit:relations          # 死边报告（report-only，见 OWNER-DECISION 注）
 *   pnpm audit:relations --json   # JSON 输出
 *   pnpm audit:relations --strict # 有死边或 stale 即非零 exit（CI gate 模式）
 *
 * ── OWNER-DECISION-PENDING ─────────────────────────────────────────────
 *
 * (1) gate 严格度：默认 **report-only**（exit 0 即使有死边）。gap-analysis 决策 7
 *     标「低优先 / 纯治理」，gate doc §1.7 标「→ Linear follow-up」（非硬 gate）。
 *     故默认只报告、不进 pre-PR 硬链；--strict 留给 owner 决定是否升级为 CI gate。
 *     备选：直接进 `pnpm test` 链当硬 gate（像 audit:draft-status）。
 *
 * (2) 「死」的判据：本脚本取「零 specialized 消费」为死（generic-read 不算救活）。
 *     这忠于 GPT §10.1「只保留能影响诊断/推荐/复习的关系」——泛化一把捞不构成
 *     type-specific 学习影响。备选更宽松判据「有 generic-read 即不算死」会让所有
 *     核心 type 都活着（knowledge-readers 一把捞所有 type），审计退化为永远全绿、
 *     失去诊断价值。本脚本同时报告三层，owner 可据此重定判据。
 *
 * 限制：CONSUMER_REGISTRY 是人维护的——新增「按 relation_type 分支」的消费路径时，
 * 须在 registry 补一条（否则该 type 可能被误报死）。反查只防「声明的路径消失」，
 * 不能自动发现「未声明的新消费路径」。这是与 sibling audit 同源的已知 shape 限制。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SRC_ROOT = join(REPO_ROOT, 'src');

const EXCLUDE_DIRS = new Set(['node_modules', '.next', 'dist', '.git', '.claude', 'drizzle']);

// ---------- relation_type universe ----------
//
// 5 个核心 relation_type（ADR-0010 §relation_type 核心集合，与
// src/core/schema/event/blocks.ts CoreRelationType 枚举一致）。experimental:* 是
// 命名空间逃逸阀（按 ADR-0006 v2 先跑稳再 promote），不是固定 type——不在死边枚举
// 里逐条审计（它本就是「探索性、未稳」的，缺消费是预期），但脚本会统计 schema
// 里实际出现的 experimental:* 前缀作可观测。
export const CORE_RELATION_TYPES = [
  'prerequisite',
  'related_to',
  'contrasts_with',
  'applied_in',
  'derived_from',
] as const;
export type CoreRelationType = (typeof CORE_RELATION_TYPES)[number];

// ---------- consumption tiers ----------

export type ConsumerTier = 'creation-validation' | 'generic-read' | 'specialized';

/**
 * 下游消费路径的辨别力。dead-edge 判据只看 specialized：
 *   - specialized > generic-read > creation-validation（按是否「按 type 差异化
 *     影响学习」）
 */
export const TIER_RANK: Record<ConsumerTier, number> = {
  'creation-validation': 0,
  'generic-read': 1,
  specialized: 2,
};

/**
 * 一条声明式消费路径：哪个 relation_type、在哪个文件、用哪个 grep marker 反查、
 * 属于哪个消费层、归到诊断/推荐/复习哪个产品维度（surface），以及一句话证据。
 */
export type ConsumerEntry = {
  relation: CoreRelationType;
  tier: ConsumerTier;
  /** repo-relative source file that consumes this edge type. */
  file: string;
  /** literal substring that MUST still appear in `file` (drift reverse-check). */
  marker: string;
  /** which learning surface: diagnosis / recommendation / review / validation. */
  surface: 'diagnosis' | 'recommendation' | 'review' | 'validation';
  evidence: string;
};

// ── CONSUMER_REGISTRY — 手维护，每条带 file:marker 反查证据 ──────────────────
//
// grounding（cite file:line，2026-06-19 实测于 origin/main）：
//   - src/server/ai/tools/knowledge-readers.ts:84 loadEdges() 无 relationTypes 过滤
//     ⇒ get_knowledge_neighborhood / find_knowledge_paths 把**所有** type 一把灌给
//     copilot（诊断/推荐上下文）。generic-read，覆盖全 5 type。
//   - src/server/ai/tools/knowledge-readers.ts:744 paths 工具对 related_to /
//     contrasts_with 加反向邻接（双向语义）⇒ 这两 type 的 specialized 路径消费。
//   - src/capabilities/knowledge/server/topology-gate.ts:52 ORDERED_RELATION =
//     'prerequisite'，环/传递冗余检测**仅**对 prerequisite ⇒ prerequisite specialized。
//   - src/capabilities/knowledge/server/hub-mesh.ts:63 RELATION_PRIORITY +
//     :72 EXCLUDED_RELATIONS。笔记 hub 自动同步按 prerequisite/derived_from/
//     contrasts_with 组装上下文，**显式排除** related_to / applied_in（rule iv）
//     ⇒ 这三 type specialized（复习/笔记上下文）。
//   - src/capabilities/knowledge/server/rubric-validator.ts:280 relationGate() 5 路
//     case（prerequisite/contrasts_with/applied_in/related_to + derived_from）⇒ 全
//     5 type 都有 creation-validation（提议时校验，非下游学习消费）。
const CONSUMER_REGISTRY: ConsumerEntry[] = [
  // ---- generic-read: copilot 邻域/路径一把灌（覆盖全 5 core type）----
  ...CORE_RELATION_TYPES.map(
    (relation): ConsumerEntry => ({
      relation,
      tier: 'generic-read',
      file: 'src/server/ai/tools/knowledge-readers.ts',
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
    file: 'src/capabilities/knowledge/server/topology-gate.ts',
    marker: "const ORDERED_RELATION = 'prerequisite'",
    surface: 'diagnosis',
    evidence:
      'topology-gate 环检测/传递冗余仅对 prerequisite 边运行（ORDERED_RELATION），驱动结构一致性诊断。',
  },
  {
    relation: 'prerequisite',
    tier: 'specialized',
    file: 'src/capabilities/knowledge/server/hub-mesh.ts',
    marker: "'prerequisite'",
    surface: 'review',
    evidence:
      'hub-mesh 笔记自动同步按 prerequisite 边（incoming）组装「这是 X 的前置」复习上下文（RELATION_PRIORITY）。',
  },

  // ---- specialized: contrasts_with ----
  {
    relation: 'contrasts_with',
    tier: 'specialized',
    file: 'src/capabilities/knowledge/server/hub-mesh.ts',
    marker: "'contrasts_with'",
    surface: 'review',
    evidence:
      'hub-mesh 按 contrasts_with 边组装「对比」复习上下文（RELATION_PRIORITY，对照辨析）。',
  },
  {
    relation: 'contrasts_with',
    tier: 'specialized',
    file: 'src/server/ai/tools/knowledge-readers.ts',
    marker: "edge.relation_type === 'contrasts_with'",
    surface: 'recommendation',
    evidence: 'find_knowledge_paths 对 contrasts_with 加反向邻接（双向语义），影响路径推荐结果。',
  },

  // ---- specialized: derived_from ----
  {
    relation: 'derived_from',
    tier: 'specialized',
    file: 'src/capabilities/knowledge/server/hub-mesh.ts',
    marker: "'derived_from'",
    surface: 'review',
    evidence:
      'hub-mesh 按 derived_from 边（to ∈ hub）组装「派生自」复习上下文（RELATION_PRIORITY）。',
  },

  // ---- specialized: related_to ----
  {
    relation: 'related_to',
    tier: 'specialized',
    file: 'src/server/ai/tools/knowledge-readers.ts',
    marker: "edge.relation_type === 'related_to'",
    surface: 'recommendation',
    evidence: 'find_knowledge_paths 对 related_to 加反向邻接（双向语义），影响路径推荐结果。',
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
  //   hub-mesh.ts:72 EXCLUDED_RELATIONS 显式排除 applied_in；topology-gate 仅
  //   prerequisite；knowledge-readers paths 反向邻接仅 related_to/contrasts_with。
  //   applied_in 只被 generic-read 一把捞 + creation-validation 校验，零特化学习消费。
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
 * Reverse-check every declared consumer: its file must exist AND its marker must
 * still appear in that file. Returns the stale entries (drift between registry and
 * code). `readFile` is injectable for unit testing without touching disk.
 *
 * Exported pure for unit testing.
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
  relation: CoreRelationType;
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
  dead: CoreRelationType[];
  stale: StaleConsumer[];
};

/**
 * Core verdict: per relation_type, compute the highest LIVE consumer tier (stale
 * entries are dropped — a declared-but-vanished consumer does NOT keep an edge
 * alive). A type is "dead" when it has no live `specialized` consumer. Exported
 * pure for unit testing.
 */
export function computeDeadEdges(
  registry: ConsumerEntry[],
  stale: StaleConsumer[],
): DeadEdgeResult {
  const staleKeys = new Set(stale.map((s) => `${s.relation}|${s.tier}|${s.file}|${s.marker}`));
  const live = registry.filter(
    (e) => !staleKeys.has(`${e.relation}|${e.tier}|${e.file}|${e.marker}`),
  );

  const verdicts: RelationVerdict[] = CORE_RELATION_TYPES.map((relation) => {
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

/**
 * Scan source for `experimental:*` relation_type literals actually wired in
 * (observability only — experimental edges are exempt from the dead-edge gate by
 * design, they are explorations expected to lack specialized consumers).
 *
 * IMPORTANT — relation_type vs event-name disambiguation: the `experimental:`
 * namespace is shared by BOTH knowledge_edge relation_types (ADR-0010, e.g.
 * `experimental:contrasts_register`) AND the event-schema's experimental EVENT
 * NAMES (e.g. `experimental:quiz_gen`, `experimental:knowledge_propose`). A flat
 * tree scan can't tell them apart and would drown the report in event names. So
 * we only count an `experimental:*` literal when its LINE also references a
 * relation_type context (`relation_type` / `new_relation_type` / `RelationType`).
 * This is a heuristic — it can miss an experimental relation declared far from any
 * relation_type token — but it eliminates the event-name false positives that make
 * the observability output useless.
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
    // Per-line scope: the literal counts only if its line also names a
    // relation_type context (filters out experimental:* event names).
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

function main(): void {
  const stale = reverseCheckConsumers(CONSUMER_REGISTRY, readFileOrNull);
  const result = computeDeadEdges(CONSUMER_REGISTRY, stale);

  const files = walkSource(SRC_ROOT).sort();
  const experimental = findExperimentalRelations(files, (f) => readFileOrNull(f) ?? '');

  const isJson = process.argv.includes('--json');
  const isStrict = process.argv.includes('--strict');

  if (isJson) {
    console.log(JSON.stringify({ ...result, experimental }, null, 2));
  } else {
    console.log('audit:relations — KG 死边反向审计 (YUK-357)\n');
    console.log('  consumption tier per core relation_type (highest LIVE tier):\n');
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

    if (experimental.length > 0) {
      console.log(
        `  experimental:* relations wired in source (gate-exempt): ${experimental.join(', ')}\n`,
      );
    }

    if (result.stale.length > 0) {
      console.log(`STALE consumer declarations (registry ↔ code drift):  ${result.stale.length}`);
      for (const s of result.stale) {
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

    if (result.dead.length === 0) {
      console.log('DEAD edges (no specialized downstream consumer):  (none)');
    } else {
      console.log(`DEAD edges (no specialized downstream consumer):  ${result.dead.length}`);
      for (const r of result.dead) {
        console.log(
          `  - ${r}: created/proposed/persisted but no diagnosis/recommendation/review path reads it by type → graph spins without affecting learning.`,
        );
      }
      console.log(
        '\nGPT §10.1「只保留能影响诊断/推荐/复习的关系」. A dead edge type is a governance ' +
          'signal: either wire a specialized consumer (make it affect learning), stop ' +
          'proposing it, or accept it as intentionally generic-only and record the rationale.',
      );
    }
  }

  // OWNER-DECISION-PENDING (1): default report-only; --strict opts into a CI gate.
  if (isStrict && !result.ok) process.exit(1);
}

// CLI-gate (mirrors audit-test-partition.ts / audit-draft-status.ts): only run +
// exit when invoked as a CLI so the self-test can import the pure functions without
// the top-level scan firing.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
