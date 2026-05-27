# Wave 1 Post-Ship Drift Audit — 2026-05-27

**Scope**: Wave 1 三个 ship 的 commit（`caccd97` YUK-37 / `aaa534c` YUK-98 / `c320446` YUK-66），相对 baseline `01c27b2` 增量审计。
**Run by**: Claude Code（general-purpose subagent, manual /audit-drift incremental run）。
**Baseline reference**: `docs/audit/2026-05-27-pre-yuk88-baseline-drift.md`（15 findings / 4 P1）。
**Not in scope**: PR #162 YUK-90 spike（branch only）；baseline 15 项中本 audit 不重审，只检 Wave 1 是否解掉。
**Skip**: schema field-level write-path drift（`pnpm audit:schema` 持续 owner）。

## Summary

| 类别 | 增量项数 | 备注 |
|---|---|---|
| ✅ Aligned | 4 | Wave 1 多项 contract 1:1 落地（详见 §Aligned）|
| ⚠️ Documented-only | 2 | driver doc / planning 写了但实际未落 |
| ⚠️ Undocumented | 3 | 代码做了但 ADR / planning 未追认 |
| ❌ Contradicted | 1 | ADR-0017 §决策第 1 触发器与实装不符 |
| ⏳ Phase-deferred | 1 | Mem0 spike Q1 显式 deferred to OPENAI_API_KEY host |
| **Baseline resolved** | 2 | F-04 / F-RA P3 已 Wave 1 落地 |

**Top-line**：3 个 ship 在 schema + 主路径上对齐 driver doc / ADR；主要漂移集中在 **post-ship contract 完整性**——event writer→Mem0 trigger 没 wire、advisor route 没传 causeCategory（CC-1 lean 死代码）、env.example / driver doc §4 templates 未对账。无一项 block 下一 Wave，但都在"已实装 80%、剩 20% 没收口"档位，下次 sweep 一定要收。

---

## ✅ Aligned（不展开，仅记录）

- **A-01** Wave 1 schema 增量与 ADR-0017 §"Schema additions" 表 4 项 1:1：`event.affected_scopes text[]` + GIN idx / `memory_brief_note.latest_evidence_at + evidence_count` / `pgvector` extension（`drizzle/0015 + 0016`）
- **A-02** `src/server/memory/{client,brief,scope_tagger,triggers}.ts` 文件位置与 ADR-0017 §"Layer 1/2" + 驱动 doc §4 一致；single-owner write path 仅 brief.ts 调 `upsertBriefInDb` / 仅 client.ts 调 Mem0 `add`
- **A-03** `question(source='teaching_check')` enum 已落 + `app/api/teaching-sessions/[id]/turn/route.ts` 在 ask_check 时持久化；attempt 路径**复用** `/api/embedded-check/attempt`（driver doc §3.1 "路径 A 不需 ADR" 命中）；arch.md L433 注释已列 `tool_quiz: embedded | teaching_check | daily ...`
- **A-04** RatingAdvisor 接口契约符合 driver doc §1.1（pure fn / FsrsRating 3-state / 0.5 boundary + carelessness/conceptual lean）+ T-RA 头注释正确引用 effectiveCauseCategoryForFailureAttempt invariant

---

## ❌ Contradicted

### W-01 [ADR-0017 §决策 / "Write triggers (three paths)"] Event-ingest 第 1 触发器没 wire 到 event writer
- **声明** ADR-0017 §"Write triggers (three paths)" #1：「every event write path tags the event with `affected_scopes` ... **A pg-boss subscriber on event creation calls `mem0.add(event)`** and enqueues brief regen for affected scopes」
- **代码**：`src/server/memory/triggers.ts:41-43` `enqueueEventMemoryIngest(boss, eventId)` 实装；但 grep `enqueueEventMemoryIngest` / `MEMORY_EVENT_INGEST_QUEUE` 在 `src/server/events/queries.ts`（event 唯一 writer）+ `app/api/**` + `scripts/` 中**0 生产 caller**。worker 只 register handler（`handlers.ts:44`），无人 send。
- **冲突**：handler 跑空 — event 写入后没人 enqueue ingest job，Mem0 fact 层永不更新；brief regen 只能靠 daily sweep 而非"event triggers + cron"。ADR-0017 §"Anti-storm" 6min 单例假设 burst event activity，目前 0 个 event 触发 ingest。
- **Severity**: **P1** — 触发器 1/3 缺失，"dual-layer 写路径"实际只有 cron sweep 一条
- **建议**：在 `src/server/events/queries.ts:996` event insert 之后调 `enqueueEventMemoryIngest(boss, row.id)`；同步加 unit test 验 ingest enqueue。**driver doc T-37 §1.1 #5 acceptance 写"from all event writers" 严格说没满足**——可争论是否 reopen YUK-37，或单开 follow-up。

---

## ⚠️ Documented-only

### W-02 [Driver T-37 §4 + ADR-0017 隐含] 5 个 brief template 未拆 markdown 文件
- **声明** T-37 driver §4 Files touched："`src/server/memory/templates/global.md / subject.md / topic.md / mistake_cluster.md / meta_orchestrator.md`" 5 个独立模板文件 + §1.1 #6 acceptance "Per-prefix brief templates —— 5 fixed scope prefix 的 markdown 模板"
- **代码** `src/server/memory/brief.ts:6-17`：5 个 prefix 模板**全 inline** 在 `BRIEF_TEMPLATES` const object（每个仅 ~1 行 string），无 `templates/` 子目录
- **冲突**：实装比 driver 简化（理由可能：模板还在 1-liner 阶段，拆文件太早）；但 acceptance 字面"markdown 模板"未满足
- **Severity**: **P3**（实装更轻巧；driver doc 应同步改成 "inline TEMPLATES const" 或 acknowledge MVP 简化）
- **建议**：要么把 T-37 driver §4 改成 reflects 实装，要么留 follow-up 在模板长出来时拆文件

### W-03 [Driver T-RA §3 step 1 + T-37 §0.2] Linear status 校准动作未明示完成
- **声明** T-RA driver §3 Pre-flight step 1：「Create Linear issue per §0.2 body 草稿；获取 YUK-XX ID」；T-37 driver §0.2：「Reopen YUK-37 to In Progress」+「Update master roadmap §2.2 + §11 T-37 card：5pt → 13pt」+「Update Wave 1 估时：4 周 → 5 周」
- **代码**：YUK-98 已存在（commit message `Closes YUK-98`），T-RA 这步已做；T-37 reopen 状态不可代码层验证（Linear 是 external state）；master roadmap pt/估时更新状态需 grep roadmap doc
- **Severity**: **N/A** — out of audit scope（Linear 状态走 issue capture gate，不进 drift 报告）
- **建议**：在 closeout 时手动确认 Linear 状态正确

---

## ⚠️ Undocumented

### W-04 [.env.example] 缺 OPENAI_API_KEY + MEM0_* 但 ADR-0017 errata 已强制
- **声明** ADR-0017 Errata 2026-05-27 + spike-findings：「T-37 therefore defaults the fact layer to Mem0's `openai` embedder ... `OPENAI_API_KEY`」；`src/server/memory/client.ts:63` `requireEnv(env, 'OPENAI_API_KEY')` —— **运行时必需**
- **代码** `.env.example`：列了 `ANTHROPIC_API_KEY / XIAOMI_API_KEY / R2_* / TENCENT_* / TUNNEL_TOKEN / POSTGRES_*`，**无** `OPENAI_API_KEY`、**无** `MEM0_EMBEDDING_MODEL` / `MEM0_EMBEDDING_DIMS` / `MEM0_LLM_MODEL` / `MEM0_PGVECTOR_COLLECTION` / `MEM0_PGVECTOR_HNSW` / `MEM0_PGVECTOR_DISKANN` / `MEM0_ANTHROPIC_BASE_URL`
- **冲突**：YUK-37 ship 后新部署或新 dev clone 会在 `createMemoryClient()` 第一调拋 "Mem0 memory client requires OPENAI_API_KEY"；README L76 也无新键
- **Severity**: **P1**（onboarding / deploy blocker；handler 在 worker 启动跑，第一个 event ingest 就炸 — 但参考 W-01，没人触发 ingest，所以暂时没炸）
- **建议**：补 `.env.example`：`OPENAI_API_KEY=` 必填注释 + MEM0_* 6 个 optional 注释 default 值；README §Setup 加一节 Mem0 / OPENAI 解释（ADR-0017 errata 说"on this machine OPENAI_API_KEY 缺"）

### W-05 [App routes vs RatingAdvisor 契约] advice / submit 都未传 causeCategory
- **声明** `src/server/review/rating-advisor.ts:5-15` 头注释 + driver T-RA §1.1：「callers MUST pass the result of effectiveCauseCategoryForFailureAttempt() so the cause source-of-truth stays single-owner」+ T-RA §1.1 「cause 类别影响（per CC-1 cause precedence）：carelessness → 倾向 'good'；conceptual_error → 倾向 'again'」
- **代码** `app/api/review/advice/route.ts:66` `judgeResultToRatingAdvice(invoked.result)` — **未传 ctx**；`app/api/review/submit/route.ts:246` 同样 `judgeResultToRatingAdvice(suppliedJudgeResult)` — **未传 ctx**。submit route L241-242 还有 explicit 注释 "callers SHOULD thread the effectiveCauseCategoryForFailureAttempt() output into judgeResultToRatingAdvice(..., { causeCategory })" 但实装没做
- **冲突**：advisor `causeLean` 函数永远收 `undefined` → 永远 return 0 → partial credit 永远走默认 again/hard，从不应用 carelessness/conceptual lean。**driver acceptance §2 第 1 项**「6 个边界 case 含 `score=0.4 + carelessness / score=0.4 + conceptual`」单元 test 过但**生产路径死代码**。
- **Severity**: **P1**（acceptance criteria 字面满足但 e2e 行为 contract 没接住；YUK-98 立项目标"cause-aware advisor"等于没生效）
- **建议**：在 advice / submit route 调 `effectiveCauseCategoryForFailureAttempt(failure)`（或对应的 cause SoT 读取），传给 `judgeResultToRatingAdvice(result, { causeCategory })`。补一个 integration test：submit response.judge.suggested_rating 在 partial+carelessness 场景下应是 'good' 不是 'hard'。

### W-06 [ADR-0017 §决策 #2 chat-derived trigger] meta:orchestrator_self scope 自动识别但无 caller
- **声明** ADR-0017 §"Write triggers" #2：「Copilot conversation turns can produce user-preference facts ... Per turn, the orchestrator decides whether to call `mem0.add(chat_message, scope='meta:orchestrator_self')`」+ scope_tagger.ts:69-76 已实装 `action.includes('chat'|'tool_use'|'orchestrator')` → 自动 attach `meta:orchestrator_self`
- **代码**：grep `'meta:orchestrator_self'` in `src/server/orchestrator/**` + `app/api/**` 0 命中；scope_tagger 在 event 写入路径**会 attach**，但 W-01 说 event→Mem0 ingest 没 wire，所以这条也是 silent dead path
- **Severity**: **P2**（与 W-01 同根因；W-01 修了之后这条自动激活；不独立 ticket）
- **建议**：跟 W-01 一起修；test scope_tagger 已覆盖该 branch

---

## ⏳ Phase-deferred（informational）

### W-07 [T-37 spike-findings §Q1 Chinese embedding 召回] OPENAI_API_KEY 不在 spike host
- **声明** `t37-mem0-spike-findings.md:236`：「Chinese embedding quality ⚠️ **not executed on this machine** — Q1 is answered as OpenAI `text-embedding-3-small`, but the runtime has no `OPENAI_API_KEY` to run the 34-event recall probe」
- **代码**：spike 决策 = 「Default OpenAI embedder + text-embedding-3-small」；client.ts:72 hardcode `DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small'`；recall validation 显式 deferred 到 has-OPENAI_API_KEY host
- **Severity**: **P2 / phase-deferred** — driver doc + spike-findings 已显式标 deferred；W-04 修完 env.example 后下一 host 启动会自动跑（应有人工 verify recall ≥ 60%）
- **建议**：W-04 + W-01 修完后，启 worker 跑一次 spike recall probe，结果记入 spike-findings 后追评

---

## Baseline 15 findings — Wave 1 后状态

| ID | 状态 | 证据 |
|---|---|---|
| **F-01** notes.md ADR-0020 冲突 | 仍 live | YUK-88 P1 未启动；本 audit 不另报 |
| **F-02** artifact 表 pre-ADR-0020 形态 | 仍 live | `schema.ts:117/296/300` `extracted_prompt_md / child_artifact_ids / outline_json` 仍在；expected baseline |
| **F-03** CorrectArtifactEvent.section_id | 仍 live | YUK-88 P1 改名；expected |
| **F-04** memory/dreaming 目录缺失 | ✅ **resolved by caccd97** | `src/server/memory/{client,brief,scope_tagger,triggers}.ts` 全在；`dreaming/` 仍不存在但 ADR-0017 §"Touching ADR-0015 §2" 显式将所有权迁到 `memory/`，符合预期。注意 W-01：目录在不等于完整 wire |
| **F-05** architecture.md §5.1 task 表 | 仍 aligned | unchanged |
| **F-06** ai_task_runs FK 缺失 | 仍 live | Wave 1 未涉及 |
| **F-07** Copilot tools stale claim | 仍 stale | Wave 1 未涉及 |
| **F-08** YUK-62/63 plan checkbox | 仍 stale | doc sweep 范围 |
| **F-09** force-directed graph | 仍 ⬜ | Wave 1 未涉及；ADR-0020 已显式 phase-deferred |
| **F-10** knowledge.approval_status enum | 仍 live | schema lint owner |
| **F-11** extracted_prompt_md 列 | 仍 live | `schema.ts:117` |
| **F-12-15** module docs disclaimer | 仍 live | YUK-88 后 P4.8 sweep |
| **F-RA**（隐式 P3 partial credit advisor）| ✅ **resolved by aaa534c** | rating-advisor.ts + route + UI 落地；但 W-05 揭露 contract 接住不全 |

净：baseline 4 P1 中 1 项（F-04）resolved，3 项（F-01/02/03）期待 YUK-88；新增 2 个 P1（W-01 / W-04 / W-05）属 Wave 1 internal completeness gap。

---

## Severity 总览

| Severity | 新增项数 | 描述 |
|---|---|---|
| **P1** | 3（W-01 / W-04 / W-05）| Wave 1 ship 后 contract 没收口；不修等于"做了 80%" |
| **P2** | 1（W-06）| 与 W-01 同根因 |
| **P3** | 1（W-02）| driver doc 与实装格式 mismatch |
| **Phase-deferred** | 1（W-07）| 显式 deferred，W-04 修完后激活 |
| **Aligned** | 4（A-01..A-04）| 不另开 ticket |

## 推荐 follow-up（report-only，不开 Linear）

1. **YUK-{TBD-A}** — Wave 1 brief writer 收口：event writer wire `enqueueEventMemoryIngest` + env.example / README OPENAI_API_KEY + MEM0_* + W-06 同根因 ingest path test（合并 W-01 / W-04 / W-06 / W-07 follow-on）
2. **YUK-{TBD-B}** — RatingAdvisor cause wiring：advice + submit route 调用 cause helper 并传 ctx；补 e2e test 验 carelessness lean（W-05）
3. **YUK-{TBD-C}** — T-37 driver §4 templates 路径与实装对账（W-02；与 P4.8 sweep 合并）

不需 Linear issue 的项：W-03（pre-flight 状态，已超 audit scope）；F-01..F-15 见 baseline 报告。

---

**结束。Time spent**：~22 min。
**Evidence trail**：
- `src/server/memory/{client.ts:63,72 / brief.ts:6-17 / triggers.ts:14,41-43,136-138 / scope_tagger.ts:38-79}`
- `src/server/events/queries.ts:24,946,981,996`
- `app/api/review/advice/route.ts:17,66`、`app/api/review/submit/route.ts:44,241-246`
- `app/api/teaching-sessions/[id]/turn/route.ts:119`、`app/api/embedded-check/attempt/route.ts:43-45`
- `src/server/review/rating-advisor.ts:5-15,41-46,50-59,110-120`
- `drizzle/0015_memory_brief_writer.sql`、`drizzle/0016_far_whirlwind.sql`
- `docs/adr/0017-memory-mem0-plus-brief-layer.md` §决策 / Errata 2026-05-27
- `docs/superpowers/plans/2026-05-27-t37-brief-writer-driver.md §1.1 #5 / §4`
- `docs/superpowers/plans/2026-05-27-tra-rating-advisor-driver.md §1.1`
- `docs/superpowers/plans/2026-05-27-t66-teaching-ask-check-driver.md §3.1`
- `docs/superpowers/plans/2026-05-27-t37-mem0-spike-findings.md:236`
- `.env.example`（无 OPENAI_API_KEY / MEM0_*）
- baseline `docs/audit/2026-05-27-pre-yuk88-baseline-drift.md` F-04 / F-RA 对照
