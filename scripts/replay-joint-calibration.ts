// pnpm replay:joint-calibration (YUK-439) — 现行方案 vs 联合标定的历史重放对照。
//
// ─── 安全边界（票面红线）────────────────────────────────────────────────────
// READ-ONLY / REPORT-ONLY（--seed-legacy-db 模式只写它自建的合成 fixture 行，标注
// syn_ 前缀 id）。只连 DATABASE_URL 指向的本地/隔离库（或 --synthetic 纯内存，零 DB
// 接触）；绝不写学习状态、绝不翻 flag、绝不触 TEST(8787)/生产、绝不调模型。
//
// ─── 用法 ──────────────────────────────────────────────────────────────────
//   pnpm replay:joint-calibration --synthetic            # 内存合成史（默认 2000 作答）
//   pnpm replay:joint-calibration --synthetic=5000 --json
//   pnpm replay:joint-calibration --synthetic --seed=1   # 多 seed 复核（默认 0x439）
//   DATABASE_URL=... pnpm replay:joint-calibration      # 从 DB 读真实历史（owner 本地跑）
//   DATABASE_URL=... pnpm replay:joint-calibration --seed-legacy-db
//                                                         # 合成史写进隔离库（legacy 事件形状）
//                                                         # 再从 DB 读回跑——端到端验证
//                                                         # migration + loader + 引擎
//
// ─── 两侧定义（见 src/server/calibration/joint-replay.ts）────────────────────
// incumbent = 现行 main（θ̂ Elo + b_calib ?? b_anchor 读链 + ≥12 标签 AIPW firm-up 夜跑
// 模拟）；joint = YUK-439（θ̂ Elo + b_post 批量后验）。同一作答史、各自 θ̂ 轨迹、
// 事前预测配对比较（log loss 分数伯努利 + 二元子集 ECE + 按题配对 cluster bootstrap）。
//
// ─── loader 口径（--from-db / --seed-legacy-db）─────────────────────────────
// 兼容两代作答史：
//   - legacy：event(action IN ('review','attempt'), subject_kind='question') + sibling judge
//     事件（non-unsupported；score 取 judge payload.score，缺省按二元 outcome）；
//   - assessment：event(action='experimental:assessment_attempt') + 同 submission 的
//     最新 applied settlement（verdict.normalized 作分数、judgeRoute、stream_item_id；
//     更正跟随最新有效结算）。
// 限制（如实）：legacy 行无容器 ref ⇒ 试卷/placement 来源在 loader 落 'solo' 桶；
// π_i 按被答 slot join selection_observation（同 label hook 判别子），join 不到按 due/solo。

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../server/env';

// db/client 与 loadEnv 都在模块顶层校验 DATABASE_URL（worker.ts 同款纪律）。--synthetic
// 纯内存模式不触库，但要先给一个合法占位 URL。占位值只在 DATABASE_URL 未设时填充——
// 真实回放必须显式指向本地/隔离库（--from-db / --seed-legacy-db）。
if (process.env.DATABASE_URL === undefined) {
  process.env.DATABASE_URL = 'postgres://placeholder.invalid/placeholder';
}

loadEnv();

// 引擎/类型经动态 import 载入：上面的占位 URL 必须先就位（ESM 静态 import 会整体
// 提升，占位逻辑会晚于 db/client 的顶层校验执行）。
type JointReplayAttempt = import('@/server/calibration/joint-replay').JointReplayAttempt;

// ─────────────────────────────────────────────────────────────────────────────
// 合成史生成器（mulberry32 确定性）：已知真值（true_b、真 θ 漂移），让「joint 收敛
// 真值、incumbent 停在噪锚」的对照可解释。参数是占位裁决（owner 可调）。
// ─────────────────────────────────────────────────────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rng: () => number): number {
  // Box–Muller。
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

interface SyntheticWorld {
  attempts: JointReplayAttempt[];
  trueB: Map<string, number>;
  anchors: Map<string, number>;
  qKcs: Map<string, string[]>;
  domainByKc: Record<string, string | null>;
}

export function generateSyntheticHistory(nAttempts: number, seed = 0x439): SyntheticWorld {
  const rng = mulberry32(seed);
  const kcIds = Array.from({ length: 12 }, (_, i) => `syn_kc_${i}`);
  const domains = ['syn_dom_a', 'syn_dom_b'];
  const domainByKc: Record<string, string | null> = {};
  kcIds.forEach((kc, i) => {
    domainByKc[kc] = domains[i % 2];
  });
  // 真值：题难度 + 学习者 per-KC θ（缓慢上升 = 非平稳主线）+ 域全局。
  const questionIds = Array.from({ length: 60 }, (_, i) => `syn_q_${i}`);
  const trueB = new Map<string, number>();
  const qKcs = new Map<string, string[]>();
  const anchors = new Map<string, number>();
  for (const q of questionIds) {
    const multiKc = rng() < 0.2;
    const kcs = multiKc
      ? [...new Set([kcIds[Math.floor(rng() * 12)], kcIds[Math.floor(rng() * 12)]])]
      : [kcIds[Math.floor(rng() * 12)]];
    qKcs.set(q, kcs);
    const b = Math.max(-2.5, Math.min(2.5, gauss(rng) * 1.4));
    trueB.set(q, b);
    // llm_prior 噪锚（BEA 2024 量级：先验与真值差 ~N(0,1)）。
    anchors.set(q, Math.max(-3, Math.min(3, b + gauss(rng) * 1.0)));
  }
  const thetaKc = new Map(kcIds.map((kc) => [kc, gauss(rng) * 0.5]));
  const thetaGlobal = new Map(domains.map((d) => [d, gauss(rng) * 0.3]));

  const sourceMix: Array<[string, number]> = [
    ['stream_softmax', 0.5],
    ['due', 0.15],
    ['solo', 0.15],
    ['paper', 0.15],
    ['placement', 0.05],
  ];
  const pickSource = () => {
    let r = rng();
    for (const [src, w] of sourceMix) {
      if (r < w) return src;
      r -= w;
    }
    return 'solo';
  };

  const attempts: JointReplayAttempt[] = [];
  const t0 = Date.UTC(2026, 5, 1, 9, 0, 0);
  for (let i = 0; i < nAttempts; i++) {
    const q = questionIds[Math.floor(rng() * questionIds.length)];
    const kcs = qKcs.get(q) as string[];
    const b = trueB.get(q) as number;
    // 合取真值概率 P = ∏ σ(θ_eff − b)。
    let pTrue = 1;
    for (const kc of kcs) {
      const th = (thetaKc.get(kc) ?? 0) + (thetaGlobal.get(domainByKc[kc] ?? '') ?? 0);
      pTrue *= 1 / (1 + Math.exp(-(th - b)));
    }
    const outcome: 0 | 1 = rng() < pTrue ? 1 : 0;
    // 分数：二元为主；模型判分路由上 ~25% 部分分。
    const judgeRoute = rng() < 0.55 ? 'exact' : 'contract_evaluation';
    let score = outcome === 1 ? 1 : 0;
    if (judgeRoute === 'contract_evaluation' && rng() < 0.25) {
      score = 0.2 + rng() * 0.6;
    }
    const evidenceSource = pickSource();
    attempts.push({
      eventId: `syn_${i}`,
      questionId: q,
      knowledgeIds: kcs,
      scoredKnowledgeId: kcs.length === 1 ? kcs[0] : null,
      domainByKc,
      outcome,
      score,
      difficulty: 3,
      bAnchor: anchors.get(q) ?? null,
      anchorSource: 'llm_prior',
      bWeight: 1,
      evidenceSource,
      judgeRoute,
      judgeConfidence: judgeRoute === 'contract_evaluation' ? 0.5 + rng() * 0.45 : null,
      inclusionProbability: evidenceSource === 'stream_softmax' ? 0.1 + rng() * 0.8 : null,
      responseTimeMs: rng() < 0.7 ? 8000 + rng() * 40000 : null,
      createdAt: t0 + i * 90_000,
    });
    // 学习者真值漂移（在学）：作答触及的 KC 小幅上升。
    for (const kc of kcs) {
      thetaKc.set(kc, (thetaKc.get(kc) ?? 0) + 0.004);
      const d = domainByKc[kc];
      if (d !== null) thetaGlobal.set(d, (thetaGlobal.get(d) ?? 0) + 0.0008);
    }
  }
  return { attempts, trueB, anchors, qKcs, domainByKc };
}

// ─────────────────────────────────────────────────────────────────────────────
// DB loader（--from-db / --seed-legacy-db 读回）：thin seam。READ-ONLY。
// ─────────────────────────────────────────────────────────────────────────────
async function loadAttemptsFromDb(): Promise<JointReplayAttempt[]> {
  const { and, asc, desc, eq, inArray } = await import('drizzle-orm');
  const { db } = await import('@/db/client');
  const { event, item_calibration, question, selection_observation } = await import('@/db/schema');

  const out: JointReplayAttempt[] = [];

  // ── assessment 代：attempt 事件 + 最新 applied settlement（per submission）。──
  const attemptEvents = await db
    .select({
      id: event.id,
      payload: event.payload,
      created_at: event.created_at,
      subject_id: event.subject_id,
    })
    .from(event)
    .where(
      and(eq(event.action, 'experimental:assessment_attempt'), eq(event.subject_kind, 'question')),
    )
    .orderBy(asc(event.created_at), asc(event.id));
  const settlementRows = await db
    .select({ payload: event.payload, created_at: event.created_at })
    .from(event)
    .where(eq(event.action, 'experimental:assessment_settlement'))
    .orderBy(desc(event.created_at));
  // submission → 最新 applied settlement 的 plan 片段（更正跟随最新有效结算）。
  const latestApplied = new Map<
    string,
    { normalized: number | null; judgeRoute: string | null; containerRef: string | null }
  >();
  for (const row of settlementRows) {
    const p = (row.payload ?? {}) as Record<string, unknown>;
    if (p.effect !== 'applied') continue;
    const submissionId = p.submission_id;
    if (typeof submissionId !== 'string' || latestApplied.has(submissionId)) continue;
    const plan = (p.replay_inputs ?? null) as Record<string, unknown> | null;
    const verdict = plan?.verdict as Record<string, unknown> | null | undefined;
    const normalized =
      verdict && typeof verdict.normalized === 'number' ? verdict.normalized : null;
    const judgeRoute = plan && typeof plan.judgeRoute === 'string' ? plan.judgeRoute : null;
    const calibration = plan?.calibration as Record<string, unknown> | null | undefined;
    const containerRef =
      calibration && typeof calibration.containerRef === 'string' ? calibration.containerRef : null;
    latestApplied.set(submissionId, { normalized, judgeRoute, containerRef });
  }

  const questionIds = new Set<string>();
  const partials: Array<{
    eventId: string;
    questionId: string;
    score: number;
    judgeRoute: string | null;
    containerRef: string | null;
    streamItemId: string | null;
    createdAt: number;
  }> = [];
  for (const ev of attemptEvents) {
    if (ev.subject_id === null) continue;
    const payload = (ev.payload ?? {}) as Record<string, unknown>;
    const submissionId = payload.submission_id;
    if (typeof submissionId !== 'string') continue;
    const settled = latestApplied.get(submissionId);
    if (settled === undefined || settled.normalized === null) continue;
    const streamItemId = typeof payload.stream_item_id === 'string' ? payload.stream_item_id : null;
    questionIds.add(ev.subject_id);
    partials.push({
      eventId: ev.id,
      questionId: ev.subject_id,
      score: settled.normalized,
      judgeRoute: settled.judgeRoute,
      containerRef: settled.containerRef,
      streamItemId,
      createdAt: new Date(ev.created_at as unknown as string).getTime(),
    });
  }

  // ── legacy 代：review/attempt + sibling judge。──
  const legacyEvents = await db
    .select({
      id: event.id,
      outcome: event.outcome,
      payload: event.payload,
      created_at: event.created_at,
      subject_id: event.subject_id,
    })
    .from(event)
    .where(and(inArray(event.action, ['review', 'attempt']), eq(event.subject_kind, 'question')))
    .orderBy(asc(event.created_at), asc(event.id));
  const legacyIds = legacyEvents.map((e) => e.id);
  const judgeByAttempt = new Map<string, { score: number | null; route: string | null }>();
  if (legacyIds.length > 0) {
    const judgeEvents = await db
      .select({ caused_by: event.caused_by_event_id, payload: event.payload })
      .from(event)
      .where(
        and(
          eq(event.action, 'judge'),
          eq(event.subject_kind, 'event'),
          inArray(event.caused_by_event_id, legacyIds),
        ),
      );
    for (const j of judgeEvents) {
      if (j.caused_by === null) continue;
      const p = (j.payload ?? {}) as Record<string, unknown>;
      if (p.coarse_outcome === 'unsupported') continue;
      judgeByAttempt.set(j.caused_by, {
        score: typeof p.score === 'number' ? p.score : null,
        route: typeof p.judge_route === 'string' ? p.judge_route : null,
      });
    }
  }
  for (const ev of legacyEvents) {
    if (ev.subject_id === null) continue;
    const judged = judgeByAttempt.get(ev.id);
    if (judged === undefined) continue; // production θ̂ 未跑（audit-calibration 同口径）。
    const outcome: 0 | 1 = ev.outcome === 'success' ? 1 : 0;
    const score = judged.score !== null ? judged.score : outcome;
    const payload = (ev.payload ?? {}) as Record<string, unknown>;
    questionIds.add(ev.subject_id);
    partials.push({
      eventId: ev.id,
      questionId: ev.subject_id,
      score,
      judgeRoute:
        judged.route === 'exact' || judged.route === 'keyword' ? 'exact' : 'contract_evaluation',
      containerRef: null,
      streamItemId: typeof payload.stream_item_id === 'string' ? payload.stream_item_id : null,
      createdAt: new Date(ev.created_at as unknown as string).getTime(),
    });
  }

  if (partials.length === 0) return out;
  const qIds = [...questionIds];
  const qRows = await db
    .select({
      id: question.id,
      knowledge_ids: question.knowledge_ids,
      difficulty: question.difficulty,
    })
    .from(question)
    .where(inArray(question.id, qIds));
  const qById = new Map(qRows.map((r) => [r.id, r]));
  const calRows = await db
    .select({
      question_id: item_calibration.question_id,
      b_anchor: item_calibration.b_anchor,
      b: item_calibration.b,
      source: item_calibration.source,
    })
    .from(item_calibration)
    .where(and(inArray(item_calibration.question_id, qIds), eq(item_calibration.track, 'hard')));
  const calByQ = new Map(calRows.map((r) => [r.question_id, r]));
  // π lookup（softmax slot 判别，同 label hook）。
  const slotIds = partials.map((p) => p.streamItemId).filter((x): x is string => x !== null);
  const piBySlot = new Map<string, number>();
  if (slotIds.length > 0) {
    const obsRows = await db
      .select({
        stream_item_id: selection_observation.stream_item_id,
        pi: selection_observation.inclusion_probability,
      })
      .from(selection_observation)
      .where(
        and(
          inArray(selection_observation.stream_item_id, [...new Set(slotIds)]),
          eq(selection_observation.policy, 'softmax_mfi'),
          eq(selection_observation.selected, true),
        ),
      );
    for (const o of obsRows) {
      if (o.stream_item_id !== null && o.pi !== null) piBySlot.set(o.stream_item_id, o.pi);
    }
  }

  partials.sort((a, b) => a.createdAt - b.createdAt);
  for (const p of partials) {
    const q = qById.get(p.questionId);
    if (q === undefined) continue;
    const kcs = q.knowledge_ids.map((s) => s.trim()).filter((s) => s.length > 0);
    if (kcs.length === 0) continue;
    const cal = calByQ.get(p.questionId);
    const evidenceSource =
      p.containerRef !== null
        ? p.containerRef.startsWith('paper_')
          ? 'paper'
          : p.containerRef.startsWith('placement:')
            ? 'placement'
            : p.containerRef.startsWith('probe:')
              ? 'probe'
              : p.containerRef.startsWith('ingestion:')
                ? 'ingestion'
                : p.containerRef.startsWith('worksheet:')
                  ? 'worksheet'
                  : 'solo'
        : p.streamItemId !== null
          ? piBySlot.has(p.streamItemId)
            ? 'stream_softmax'
            : 'due'
          : 'solo';
    out.push({
      eventId: p.eventId,
      questionId: p.questionId,
      knowledgeIds: kcs,
      scoredKnowledgeId: kcs.length === 1 ? kcs[0] : null,
      domainByKc: {}, // hierarchical drift off in replay（域解析是审计面，非对照必需）。
      outcome: p.score >= 0.5 ? 1 : 0,
      score: p.score,
      difficulty: q.difficulty,
      bAnchor: cal?.b_anchor ?? cal?.b ?? null,
      anchorSource: cal?.source ?? null,
      bWeight: cal !== undefined ? 1 : 0.3,
      evidenceSource,
      judgeRoute: p.judgeRoute ?? 'contract_evaluation',
      judgeConfidence: null,
      inclusionProbability: p.streamItemId !== null ? (piBySlot.get(p.streamItemId) ?? null) : null,
      responseTimeMs: null, // loader 不带 RT（SRT 关闭，二元 credit——两侧同待遇）。
      createdAt: p.createdAt,
    });
  }
  return out;
}

/**
 * --seed-legacy-db：把合成史写成 legacy 事件形状（syn_ 前缀 id，自识别、可整批删除）
 * 进 DATABASE_URL 指向的隔离库，供 --from-db 读回端到端验证。只写 fixture 行：
 * question / item_calibration / event(review+judge) / selection_observation（π）/
 * difficulty_calibration_evidence（theta_snapshot=0 占位——批机器端到端 smoke 用；
 * 真实语义验证在内存 replay（那里的 θ 快照是真的））。试卷/placement 来源行在 legacy
 * 形状下不可区分容器 ⇒ 一律落 solo（文档化）。
 */
async function seedLegacyDb(world: SyntheticWorld): Promise<void> {
  const evidence = (await import('@/db/schema')).difficulty_calibration_evidence;
  const { db } = await import('@/db/client');
  const { event, item_calibration, question, selection_observation } = await import('@/db/schema');
  const now = new Date();
  for (const [q, kcs] of world.qKcs) {
    await db
      .insert(question)
      .values({
        id: q,
        kind: 'short_answer',
        prompt_md: `synthetic replay fixture ${q}`,
        reference_md: null,
        knowledge_ids: kcs,
        difficulty: 3,
        source: 'manual',
        draft_status: null,
        variant_depth: 0,
        created_at: now,
        updated_at: now,
        version: 0,
      })
      .onConflictDoNothing();
    const anchor = world.anchors.get(q) ?? 0;
    await db
      .insert(item_calibration)
      .values({
        id: `syn_cal_${q}`,
        question_id: q,
        b: anchor,
        b_anchor: anchor,
        b_post: anchor,
        posterior_variance: 2.0 * 2.0,
        calibration_source: 'prior',
        confidence: 0.5,
        track: 'hard',
        source: 'llm_prior',
        created_at: now,
        updated_at: now,
      })
      .onConflictDoNothing();
  }
  for (const a of world.attempts) {
    const at = new Date(a.createdAt);
    const isStream = a.evidenceSource === 'stream_softmax';
    const slotId = isStream ? `syn_slot_${a.eventId}` : null;
    await db.insert(event).values({
      id: a.eventId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'review',
      subject_kind: 'question',
      subject_id: a.questionId,
      outcome: a.score >= 0.5 ? 'success' : 'failure',
      payload: {
        fsrs_rating: 'good',
        fsrs_state_after: { synthetic: true },
        ...(slotId !== null ? { stream_item_id: slotId } : {}),
      },
      created_at: at,
    });
    await db.insert(event).values({
      id: `syn_judge_${a.eventId}`,
      actor_kind: 'agent',
      actor_ref: 'synthetic-replay',
      action: 'judge',
      subject_kind: 'event',
      subject_id: a.eventId,
      outcome: 'success',
      caused_by_event_id: a.eventId,
      payload: {
        cause: { source: 'agent', category: 'auto' },
        referenced_knowledge_ids: a.knowledgeIds,
        coarse_outcome: a.score >= 0.85 ? 'correct' : a.score <= 0 ? 'incorrect' : 'partial',
        score: a.score,
        judge_route: a.judgeRoute === 'exact' ? 'exact' : 'semantic',
        execution_provenance:
          a.judgeRoute === 'exact'
            ? {
                kind: 'deterministic',
                version: 1,
                prompt_fingerprint: '0'.repeat(64),
                prompt_template_revision: 'synthetic',
              }
            : {
                kind: 'invoked',
                version: 1,
                task_run_id: 'synthetic',
                provider: 'synthetic',
                model: 'synthetic',
                prompt_fingerprint: '0'.repeat(64),
                prompt_template_revision: 'synthetic',
              },
      },
      created_at: at,
    });
    if (slotId !== null && a.inclusionProbability !== null) {
      await db.insert(selection_observation).values({
        id: `syn_obs_${a.eventId}`,
        date: at.toISOString().slice(0, 10),
        stream_item_id: slotId,
        ref_kind: 'question',
        ref_id: a.questionId,
        policy: 'softmax_mfi',
        selected: true,
        inclusion_probability: a.inclusionProbability,
        signals: {},
        created_at: at,
      });
    }
    await db.insert(evidence).values({
      id: `syn_ev_${a.eventId}`,
      question_id: a.questionId,
      attempt_event_id: a.eventId,
      theta_snapshot: 0,
      score: a.score,
      evidence_source: slotId !== null ? 'stream_softmax' : 'solo',
      judge_route: a.judgeRoute,
      judge_confidence: a.judgeConfidence,
      inclusion_probability: a.inclusionProbability,
      created_at: at,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI。
// ─────────────────────────────────────────────────────────────────────────────
function formatReport(
  r: import('@/server/calibration/joint-replay').JointReplayResult,
  mode: string,
): string {
  const lines: string[] = [];
  lines.push(`YUK-439 joint-calibration replay (${mode})`);
  lines.push(`  scored single-KC steps               = ${r.nScored}`);
  lines.push(`  log loss  incumbent                  = ${r.logLossIncumbent.toFixed(6)}`);
  lines.push(`  log loss  joint                      = ${r.logLossJoint.toFixed(6)}`);
  lines.push(
    `  Δ log loss (incumbent − joint)       = ${r.logLossDelta.toFixed(6)}  (>0 ⇒ joint 更好)`,
  );
  lines.push(
    `  paired cluster bootstrap 95% CI of Δ = [${r.deltaCi.lo.toFixed(6)}, ${r.deltaCi.hi.toFixed(6)}] (B=${r.deltaCi.b})`,
  );
  lines.push(`  ECE (binary subset) incumbent        = ${r.eceIncumbent.toFixed(6)}`);
  lines.push(`  ECE (binary subset) joint            = ${r.eceJoint.toFixed(6)}`);
  lines.push(
    `  |b_post − b_anchor| mean/p50/p90/max  = ${r.absDeltaSummary.mean.toFixed(4)} / ${r.absDeltaSummary.p50.toFixed(4)} / ${r.absDeltaSummary.p90.toFixed(4)} / ${r.absDeltaSummary.max.toFixed(4)}`,
  );
  lines.push(`  incumbent AIPW firm-ups (≥12 labels) = ${r.incumbentFirmups} items`);
  lines.push(
    `  evidence mix = ${JSON.stringify(r.evidenceBySource)} (model-judged ${r.modelJudged})`,
  );
  return lines.join('\n');
}

export async function runCli(args: string[]): Promise<number> {
  const { replayJointComparison } = await import('@/server/calibration/joint-replay');
  const wantJson = args.includes('--json');
  const syntheticArg = args.find((a) => a.startsWith('--synthetic'));
  const seedDb = args.includes('--seed-legacy-db');
  const syntheticN = (): number => {
    const n = syntheticArg?.includes('=') ? Number(syntheticArg?.split('=')[1]) : 2000;
    return Number.isFinite(n) && n > 0 ? n : 2000;
  };
  const seedArg = args.find((a) => a.startsWith('--seed='));
  const parsedSeed = seedArg === undefined ? Number.NaN : Number(seedArg.slice('--seed='.length));
  const seed = Number.isFinite(parsedSeed) ? parsedSeed >>> 0 : 0x439;
  let attempts: JointReplayAttempt[];
  let mode: string;
  if (seedDb) {
    const world = generateSyntheticHistory(syntheticN(), seed);
    await seedLegacyDb(world);
    attempts = await loadAttemptsFromDb();
    mode = `seeded legacy DB → read back (n=${attempts.length}, seed=${seed})`;
  } else if (syntheticArg !== undefined || process.env.DATABASE_URL === undefined) {
    const world = generateSyntheticHistory(syntheticN(), seed);
    attempts = world.attempts;
    mode = `synthetic in-memory (n=${attempts.length}, seed=${seed})`;
  } else {
    attempts = await loadAttemptsFromDb();
    mode = `database (${attempts.length} attempts)`;
  }
  // --run-batch：隔离库上端到端 smoke 生产批写者（runJointCalibrationBatch）+ A6 指标出口。
  // 只在有真实 DATABASE_URL（非占位）时可用——批写者会写库。
  if (
    args.includes('--run-batch') &&
    process.env.DATABASE_URL !== 'postgres://placeholder.invalid/placeholder'
  ) {
    const { runJointCalibrationBatch } = await import('@/server/mastery/joint-calibration');
    const batch = await runJointCalibrationBatch(await (await import('@/db/client')).db);
    console.log('[run-batch] joint calibration batch result:');
    console.log(JSON.stringify(batch, null, 2));
  }
  const result = replayJointComparison(attempts, {
    batchEveryN: 40,
    modelAgreementRate: null,
    bootstrapB: 2000,
  });
  if (wantJson) {
    console.log(
      JSON.stringify({ mode, ...result, steps: undefined, bDelta: result.bDelta }, null, 2),
    );
  } else {
    console.log(formatReport(result, mode));
  }
  return 0;
}

export async function main(): Promise<void> {
  try {
    process.exitCode = await runCli(process.argv.slice(2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`replay:joint-calibration failed (operational error): ${msg}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exitCode = 2;
  } finally {
    try {
      const { db } = await import('@/db/client');
      await db.$client.end({ timeout: 5 });
    } catch {
      // pool never opened (synthetic mode) — nothing to clean up.
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
