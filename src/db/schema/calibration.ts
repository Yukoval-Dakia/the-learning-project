// Item calibration: per-item and family posteriors, difficulty labels and
// evidence, and selection observations.

import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

type JsonObject = Record<string, unknown>;

// ─────────────────────────────────────────────────────────────────────────────
// B1-W1 (ADR-0035 决定#3) — item_calibration：题目标定锚。
//
// 硬轨 b（IRT 难度，logit 尺度）是 θ̂ 更新读的外部锚。〔YUK-439 / ADR-0043 2026-10-19
// Amendment A3：识别性由每题带方差的 agent 先验承担，b 不再「锁死」——在线 attempt 路径
// 仍不写 b（b 的写者是标定批 joint-calibration.ts 与锚写者初始化），方差控制由先验 τ²
// 承接。〕难度来源链：item_calibration.b（有则用）→ 兜底 question.difficulty 经
// difficultyToLogitB 映射（弱锚，降权，VERIFY:difficulty-logit-map）。
//
// 软轨列 irt_a/irt_c/cdm_json/kt_json：n=1 无 cohort 结构性不可估
// （Stocking 1990 / B1 foundation §6.3）。本 wave 全 NULL，进 audit allowlist
// （kind:'manual'，reason 诚实写「结构性天花板，非攒够时间问题」）。
// 绝不进 p(L)/调度（ADR-0035）。
//
// 写者：ItemPriorTask applier（硬轨 b/confidence，source='llm_prior',track='hard'）
//       + 未来 fixed-anchor 慢热校准。单写者断言见 step9-invariant-audit.test.ts。
// ─────────────────────────────────────────────────────────────────────────────
export const item_calibration = pgTable(
  'item_calibration',
  {
    id: text('id').primaryKey(),
    question_id: text('question_id').notNull(),
    // 硬轨：IRT b（难度），logit 尺度。冷启由 ItemPriorTask 估，慢热由锚校准 firm-up。
    // nullable：冷启前无 row，applier 写入后非空。
    b: real('b'),
    // 标定置信度 0-1。ItemPriorTask 产出（llm_prior 多为低置信）。
    confidence: real('confidence'),
    // 'hard' | 'soft'——硬轨进 p(L)/调度，软轨永不进（ADR-0035）。
    track: text('track').notNull().default('hard'),
    // 'llm_prior' | 'llm_prior_llasa' | 'fixed_anchor' | ... ——provenance
    // （evidence-first 红线）。'llm_prior_llasa' = YUK-376 LLaSA 学生模拟反推
    // 的冷启锚（ItemPriorLlasaTask，opt-in），与 feature→b 的 'llm_prior' 区分。
    source: text('source').notNull(),
    // ── YUK-361 Phase 6 (Task 11, ADR-0043 §4 半数据驱动 b + §7 active-PPI)：
    //    b_anchor / b_calib 分离 + 重标定元数据 ──────────────────────────────
    //
    // 读 b 的终态优先链（effectiveB helper，src/server/mastery/recalibration.ts）：
    //   b_post ?? b_anchor ?? b
    // 〔YUK-439 / ADR-0043 2026-10-19 Amendment A2：读链由 b_calib ?? b_anchor ?? b 改为
    //   后验 b_post 优先；b_calib 退出读链。三者皆 logit 尺度同度量。〕
    //
    // - b_anchor：**冷启锚**（先验 b）。由 ItemPriorTask applier 与既有 `b` 列**同源**
    //   同步写入（applyItemPrior，feature→b 的 LLM-in-context 先验，低置信，
    //   source='llm_prior'）。语义即「外部供给的锚定尺度原点+单位」——n=1 下不可 owner
    //   自证，但绕开 θ-b 识别性墙的信息源（ADR-0043 §4 路线表「锚源」）。
    //   **Backfill 契约（migration 0038）**：既有有 `b` 的行，把现存 `b` 当锚回填到
    //   b_anchor（`UPDATE … SET b_anchor = b WHERE b IS NOT NULL`）。b_calib 保持 NULL
    //   直到批量重标定首次 firm-up——故 effectiveB 在重标定攒够标签前恒退回 b_anchor ?? b，
    //   零行为变更（read-compat NO-OP today，安全可接线）。
    b_anchor: real('b_anchor'),
    // - b_calib：〔YUK-439 起退役存档列〕旧 active-PPI/AIPW firm-up 值（≥12 标签一次
    //   性首写的语义已由 A3 连续后验取代）。既有值由 YUK-439 migration 一次性承接进
    //   b_post；此后无生产写者（recalibrateQuestion 转离线审计工具），effectiveB 不再
    //   读它。保留列以存历史，不删（git 历史不重写；YUK-1590 的「撤销标签旧估计写回
    //   b_calib」路径随生产写者移除而失效）。
    b_calib: real('b_calib'),
    // - calibration_n：折进后验的有效证据量（difficulty_calibration_evidence 行数；
    //   YUK-439 起语义=后验证据计数，旧「AIPW 标签数」语义随 b_calif 退役）。重标定
    //   批的 stale 判据读它（≠ 当前证据行数 ⇒ 该重算）。DEFAULT 0 = 从未重标定，backfill-safe。
    calibration_n: integer('calibration_n').notNull().default(0),
    // - calibration_weight：**后验精度** = 1/posterior_variance（YUK-439 起，A3 语义改记；
    //   旧「AIPW 有效样本量 proxy」语义随 b_calif 退役）。nullable：未标定 NULL。
    calibration_weight: real('calibration_weight'),
    // - last_calibrated_at：上次批量重标定时刻（provenance/可观测）。nullable：未重标定 NULL。
    last_calibrated_at: timestamp('last_calibrated_at', { withTimezone: true }),
    // ── YUK-439 (ADR-0043 2026-10-19 Amendment A1–A3)：先验锚定的 b 后验列 ─────────
    //    读 b 的终态优先链（recalibration.ts effectiveB）：b_post ?? b_anchor ?? b。
    //    b_calif（active-PPI 旧firm-up列）退出读链，仅作历史存档（值由 migration 回填
    //    进 b_post 一次性承接；旧 recalibrateQuestion 机器转离线审计，不再被生产调用）。
    //
    // - b_post：**后验均值**（logit 尺度）。写者三个：锚写者初始化（= μ_j，即 b_anchor）、
    //   标定批（src/server/mastery/joint-calibration.ts，从证据账本全量重算），以及结算
    //   revert/withdraw 删掉该题最后一条证据后的同事务「修回先验」
    //   （item-calibration.ts resetPosteriorToPriorIfNoEvidence——A4 更正跟随有效判分）。
    //   在线 attempt 路径只 READS（G4 改写后的红线：b 单写者由标定批保）。0 条证据 ⇒
    //   数值 = b_anchor（A3：连续收缩取代 RECALIBRATION_MIN_LABELS=12 硬切换，无 NULL
    //   哨兵、无跳变、无「首写不可逆」）。nullable：仅历史行/锚缺失行在首批前为 NULL
    //   （migration 回填 b_post = COALESCE(b_calib, b_anchor)）。
    b_post: real('b_post'),
    // - posterior_variance：后验方差（Laplace，MAP 处）。结构性 ≤ τ_j²（先验精度垫底，
    //   A2 收敛条件 1）。τ_j 由 source 经登记映射派生（core/difficulty-posterior.ts
    //   priorTau）。YUK-1557 读它（连同 calibration_source）区分「估计」与「实测标定」。
    posterior_variance: real('posterior_variance'),
    // - calibration_source：当前 b_post 的来源。'prior'（n=0，纯 agent 先验估计）|
    //   'joint'（证据已折进后验，实测标定）| 'legacy_calib'（旧 AIPW 值经 migration
    //   承接、待首批重算）。YUK-1557 的直接读取面。
    calibration_source: text('calibration_source'),
    // ── 软轨占位列（本 wave NULL，audit allowlist kind:'manual'）──
    // n=1 无 cohort 结构性不可估，不是攒够时间问题（B1 foundation §6.3）。
    irt_a: real('irt_a'), // 区分度——Stocking 1990 不可估
    irt_c: real('irt_c'), // 猜测下限
    cdm_json: jsonb('cdm_json').$type<JsonObject>(), // CDM slip/guess 画像
    kt_json: jsonb('kt_json').$type<JsonObject>(), // KT 参数
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('item_calibration_question_unique').on(t.question_id),
    index('item_calibration_track_idx').on(t.track),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// YUK-361 Phase 5 (ADR-0043 §family-级 b_personalized) — item_family_calibration：
// 家族级 b 个性化增量（n=1 逐题 b 不可估的「家族绕道」）。
//
// 背景（ADR-0043 代价行 + Phase 5 amendment）：单题 b_j 在 n=1 下结构性不可精确定
// （logit 平移不变 + N=1 校准样本），但 `(subject, primaryKnowledge, kind, source)`
// 家族级的 b_delta 在足够重复客观观测后可估——同一家族的多道题共享一个系统性
// 难度偏移信号，攒够样本后 shrinkage 守保守即可估。这是逐题 b 的家族级 fallback。
//
// 不变量①（红线）：本表 b_delta 是**独立的调整层**，永不回写 item_calibration.b
//   （那是 item-半边锁死 G4 的外部锚）。effectiveFamilyB(b_anchor, familyRow) =
//   b_anchor + shrunk_b_delta，组合在读侧发生，不污染锚本身。
//
// 两时间尺度（ADR-0043 §识别性）：θ̂ 是快尺度（每作答 Elo，state.ts），本表 b_delta
//   是慢尺度家族层（攒够客观观测才动 b_delta，门控 n≥20 + ≥5 distinct questions）。
//   慢 ≪ 快 是识别性的硬条件。
//
// 写者：src/server/mastery/personalized-difficulty.ts updateFamilyCalibration
//   （仅在客观判分 attempt tx 内 best-effort 调用，见该模块文档）。
// ─────────────────────────────────────────────────────────────────────────────
export const item_family_calibration = pgTable(
  'item_family_calibration',
  {
    id: text('id').primaryKey(),
    // familyKey(subject, primaryKnowledgeId, kind, source) = `${subject}:${pk}:${kind}:${source}`。
    // 绝不含 exact question id——家族绕道的核心（多题共享一个 b_delta）。
    family_key: text('family_key').notNull(),
    // 收缩后的家族级 b 增量（logit 尺度，与 b_anchor 同度量）。门控未过时恒 0
    // （只累 evidence_count，不应用 delta）；门控全过后 = shrinkFamilyDelta(rawDelta, n)。
    b_delta: real('b_delta').notNull().default(0),
    // 累积的客观观测条数（family 的有效样本量）。n 门控（≥20）读它。
    evidence_count: integer('evidence_count').notNull().default(0),
    // YUK-361 Phase 5 finding #2 修复 — 真正被折进 running mean 的残差条数（=「两门
    // 都过」起算的 fold 计数）。与 evidence_count 区分：evidence_count 数**全部**客观
    // 观测（含两门未过的预热条），calibrated_n 只数**实际折进 b_delta running mean**
    // 的条数。两者在 distinct 门「晚跨」时会发散：若 n 在 distinct≥5 之前就 ≥20，那些
    // 早期观测累进 evidence_count 但 b_delta 仍 0（distinct 门没过 → 没折进 mean），
    // calibrated_n 保持 0；待 distinct 门也过时从 1 起算。不变量：
    //   storedDelta = shrinkFamilyDelta(runningMeanOf(folded residuals), calibrated_n)
    // 精确成立，**与门跨越顺序无关**——反推 oldRawMean = b_delta / shrinkageFactor(
    // calibrated_n) 用同一基，round-trip 精确。两门一旦都过即恒过（n 只增、distinct 只
    // 增），故 calibrated_n 此后每条客观观测 +1。门控未过期间恒 0。
    calibrated_n: integer('calibrated_n').notNull().default(0),
    // 置信度 0-1，= shrinkage 因子 n/(n+priorStrength)。门控未过也可计算（只是不应用 delta）。
    confidence: real('confidence').notNull().default(0),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('item_family_calibration_family_unique').on(t.family_key)],
);

// ─────────────────────────────────────────────────────────────────────────────
// YUK-361 Phase 6 (Task 11, ADR-0043 §6 + §7) — difficulty_calibration_label：
// active-PPI 重标定的**标签账本**（慢热校准资产）。
//
// ─── 为什么是难度标签而非裸判分（ADR-0043 §6，承重红线）─────────────────────
// PPI 的真值目标量 `Y` = **难度 b**，不是判分。客观题判分是二元对错 + 混 θ/学习漂移，
// 裸当 b 真值会把 b 校成 response-rate/θ 混合残差（§6 明确警告）。故每条标签存的是
// **由锚定 θ̂ 反推的难度标签** b_label（IRT 反推，见 recalibration.ts 的公式文档），
// 不是 raw outcome——outcome 与 theta_snapshot 一并存档供审计/重算，但喂 AIPW 的 `Y`
// 是 b_label。单条 n=1 反推噪声大（CI 宽）是预期的——AIPW 在池上聚合去噪（§7）。
//
// ─── π_i（inclusion_probability）从何来（ADR-0043 §7 positivity）──────────────
// 只对**真随机抽样选中**的锚题打标签：π_i 来自 selection_observation（policy='softmax_mfi'
// 的 tempered-softmax sampler 写入的真 inclusion probability，∈(0,1]，满足 positivity）。
// legacy/到期项无真 π_i（确定性选题，事后归一化分数非合法 IPW 权重）→ **不打标签**
// （label hook 在 join 不到真 π_i 时 skip，见 recordDifficultyCalibrationLabel）。
//
// ─── 慢热资产 → 进 FK_ORDER 备份（archive.ts 契约）────────────────────────────
// 标签攒不回来（owner 用工具的历史，丢了即灭失），同 selection_observation /
// item_family_calibration 是承重 telemetry，进 FK_ORDER（非 BACKUP_EXCLUDED）。**新表
// 进 FK_ORDER → SCHEMA_VERSION bump 4.4→4.5**（per archive.ts:92；对比 item_calibration
// 的**列**additive 不 bump）。
//
// ─── 写者（单写者契约，step9-invariant-audit.test.ts）──────────────────────────
// 只由 src/server/mastery/recalibration.ts 的 recordDifficultyCalibrationLabel 写
// （被 submit.ts / paper-submit.ts 的 attempt 路径在 SAVEPOINT 内 best-effort 调用，
// 同家族 hook 的 tx-abort 隔离纪律——见 hook 文档）。
// ─────────────────────────────────────────────────────────────────────────────
export const difficulty_calibration_label = pgTable(
  'difficulty_calibration_label',
  {
    id: text('id').primaryKey(),
    // 被标定的题（软引用 question.id，no enforced FK）。重标定按 question_id 聚合标签。
    question_id: text('question_id').notNull(),
    // 产生本标签的 attempt/review 事件（软引用 event.id，no enforced FK）——provenance
    // （evidence-first 红线）+ 去重锚（同一 attempt 不重复打标签）。
    attempt_event_id: text('attempt_event_id').notNull(),
    // 作答时（PRE-attempt）的 θ̂——**必须**是 θ-before（同 Phase 5 family hook 的
    // thetaBefore 纪律：在 updateThetaForAttempt 之前捕获）。b_label 的反推锚定它。
    theta_snapshot: real('theta_snapshot').notNull(),
    // 客观判分二元结果：success=1 / failure=0。partial 被 hook 早返排除（同 Phase 5）。
    // 存档供审计/重算；喂 AIPW 的 Y 是下面 b_label 而非它（§6 红线）。
    outcome: integer('outcome').notNull(),
    // **难度标签**（§6）：由 (outcome, theta_snapshot) 单次 fixed-anchor IRT 反推的隐含 b。
    // 公式见 recalibration.ts impliedBLabel。单条噪声大（CI 宽），AIPW 池上聚合去噪。
    b_label: real('b_label').notNull(),
    // 纳入概率 π_i ∈ (0,1]（真随机抽样，positivity）。AIPW rectifier 的 IPW 权重分母。
    // 来自 selection_observation（softmax_mfi sampler）；hook 拒 ≤0（合法概率护栏）。
    inclusion_probability: real('inclusion_probability').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 主查询路径：按 question 取该题全部标签（重标定回放）。
    index('difficulty_calibration_label_question_idx').on(t.question_id),
    // 去重：同一 attempt 事件最多一条标签（hook onConflictDoNothing 兜底重试/并发）。
    uniqueIndex('difficulty_calibration_label_attempt_unique').on(t.attempt_event_id),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// YUK-439 (ADR-0043 2026-10-19 Amendment A4) — difficulty_calibration_evidence：
// 联合标定的**证据账本**（b_post 批量后验的输入）。
//
// ─── 与 difficulty_calibration_label 的关系 ──────────────────────────────────
// label 账本是旧 active-PPI 机器的资产（objective+softmax+二元三重门控的子集，
// b_label 反推 + IPW）；evidence 账本是联合标定的输入：**score 连续**（部分得分直接
// 进似然，A4）、**来源标签 + 判分路由入行**（非 softmax 来源也进，不再「无 π_i 就
// skip」——π_i 只在 PPI 池估计器下是必需的 IPW 校正，联合标定下每条作答是直接似然
// 观测）。migration 把既有 label 行一次性回填进本表（evidence_source='stream_softmax'、
// judge_route='exact'——旧 hook 两道门控保证了这两个值的忠实性）；此后 label 账本
// 继续由旧 hook 写（settle 路径行为被既有契约 pin），但只有本表喂 b_post。
//
// ─── 写者（单写者契约）──────────────────────────────────────────────────────
// 只由 src/server/mastery/calibration-evidence.ts recordDifficultyCalibrationEvidence
// 写（settle 的 attempt tx SAVEPOINT 内 best-effort，同 label hook 纪律）；
// 结算 revert 按 attempt_event_id 删行（更正跟随有效判分，A4）；标定批只 READS。
//
// ─── 进 FK_ORDER 备份（archive.ts 契约）──────────────────────────────────────
// 同 label 账本是慢热资产：证据攒不回来，丢了即联合标定降级回先验。新表进 FK_ORDER
// ⇒ SCHEMA_VERSION bump（per archive.ts:92）。
// ─────────────────────────────────────────────────────────────────────────────
export const difficulty_calibration_evidence = pgTable(
  'difficulty_calibration_evidence',
  {
    id: text('id').primaryKey(),
    // 被标定的题（软引用 question.id，no enforced FK）。标定批按 question_id 聚合证据。
    question_id: text('question_id').notNull(),
    // 产生本证据的 settlement 事件（软引用 event.id，no enforced FK）——provenance +
    // 去重锚（同一 settlement 至多一条，onConflictDoNothing）+ revert 删行判别子。
    attempt_event_id: text('attempt_event_id').notNull(),
    // 作答时（PRE-attempt）的 θ̂ 快照（primary KC offset θ̂，同既有 thetaBefore 纪律）。
    // 联合后验的似然 σ(θ_e − b) 锚定它（A2：批内对 θ̂ 准静态）。
    theta_snapshot: real('theta_snapshot').notNull(),
    // 连续分数 ∈ [0,1]（0/1 特例；部分得分直接进似然；unsupported/partial_unknown
    // 分数未知不进——「不造假分数」红线）。w_e 在批时按登记规则算（来源×判分可靠度），
    // 行内存 (judge_route, judge_confidence, evidence_source) 供批重算与 A6 观测。
    score: real('score').notNull(),
    // 作答来源（A4/A6.3 口径）：stream_softmax | due | solo | paper | worksheet |
    // placement | probe | ingestion。由 issuance 容器前缀 + stream slot π 解析。
    evidence_source: text('evidence_source').notNull(),
    // 判分路由类（settle 面）：'exact'（全 deterministic）| 'contract_evaluation'
    // （含模型执行单元）。批时 'exact' 可靠度 1；模型类 × 复判一致率 × confidence。
    judge_route: text('judge_route'),
    // 判分自述置信（分布形状信号，非 accuracy——D17）。nullable：未 sealed（当前
    // settle 面不携带；列备未来 sealed 后直接补，批时缺失按 1 只降不升）。
    judge_confidence: real('judge_confidence'),
    // softmax 流内选题的真 π_i（positivity）。nullable：非 softmax 来源无 π（直接
    // 似然证据，不需要也不伪造——A4「绝不伪造 π_i」）。
    inclusion_probability: real('inclusion_probability'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 主查询路径：标定批按 question 取该题全部证据（全量重算）。
    index('difficulty_calibration_evidence_question_idx').on(t.question_id),
    // 去重：同一 settlement 事件最多一条证据（重放/并发兜底）。
    uniqueIndex('difficulty_calibration_evidence_attempt_unique').on(t.attempt_event_id),
    // A6.3 来源占比观测：按来源聚合。
    index('difficulty_calibration_evidence_source_idx').on(t.evidence_source),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Selection observation（YUK-361 Phase 1，观测先行）：选题的逐项遥测。
//
// 每个被选中的候选（题或卷）落一行，记录当时的策略（policy）、是否选中
// （selected）、纳入概率 π_i（inclusion_probability，softmax 抽样产物）、以及完整
// 信号快照（signals，SelectionCandidateSignal 形态）。π_i 是 D17 推翻后 active-PPI
// 重标定**必需的慢热资产**（per-item 慢热校准从随机化选题的纳入概率反推暴露偏差），
// 不可丢——故本表是承重 telemetry，进 FK_ORDER 备份（非 BACKUP_EXCLUDED）。
//
// **本 lane 零选题行为变更**：表 + writer helper 就位，但不接进 composeDailyStream；
// 行为变更（随机化选题 + 真实 π_i 写入）是 Phase 3（roadmap Task 8）。default policy
// 仍 legacy。inclusion_probability ∈ (0, 1]，writer 拒 ≤0（合法概率护栏）。
// ─────────────────────────────────────────────────────────────────────────────
export const selection_observation = pgTable(
  'selection_observation',
  {
    id: text('id').primaryKey(),
    // 选题发生的本地日（YYYY-MM-DD），与 practice_stream_item.date 同度量。
    date: text('date').notNull(),
    // 关联的流项（软引用 practice_stream_item.id）。nullable：观测可在物化流项前
    // 落库（候选层），或对未入流的候选记录暴露偏差。
    stream_item_id: text('stream_item_id'),
    ref_kind: text('ref_kind').$type<'question' | 'paper'>().notNull(),
    ref_id: text('ref_id').notNull(),
    // 策略标识（本 lane default 'legacy'；Phase 3 起 'mfi_softmax' 等）。
    policy: text('policy').notNull(),
    selected: boolean('selected').notNull(),
    // 纳入概率 π_i ∈ (0, 1]。writer 拒 ≤0（recordSelectionObservation 校验）。
    inclusion_probability: real('inclusion_probability').notNull(),
    // 信号快照（SelectionCandidateSignal，src/core/selection-signals.ts）。
    signals: jsonb('signals').$type<JsonObject>().notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 主查询路径：按日 + ref 取观测（writer test + Phase 3 重标定回放）。
    index('selection_observation_date_ref_idx').on(t.date, t.ref_id),
    index('selection_observation_date_idx').on(t.date),
  ],
);
