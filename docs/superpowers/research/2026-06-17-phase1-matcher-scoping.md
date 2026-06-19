# Phase 1 matcher / 统一 pool-fetch 算子 — scoping note

> 自主 drive 2026-06-17 起草。**Scoping note，非完整 TDD plan**——完整 recon agent 今晚撞平台 500 两次没出；本 note 用主 session 直读 grounding，待 recon 恢复后升级为逐 task plan。来源真相：`docs/superpowers/specs/2026-06-16-acquisition-rethink-retrieval-substrate-design.md` §3/§4/§8。Phase 0（pgvector 列 + embedder + backfill + GIN）已随 #439 合入 main。

## 已确认的地基事实（直读 main）

1. **全仓无任何 pgvector 相似度查询**（grep `<=>`/`<->`/cosineDistance/l2Distance：仅 learning_session.ts:47 一条注释命中）。Phase 0 只落了**列 + backfill**，**hybrid 检索算子是 Phase 1 的真正第一块新代码**——符合 spec「算子留 Phase 1」。

2. **当前 pool-fetch 形态**（`src/server/quiz/sourcing-sequence.ts` `queryExistingPool` :114-142）：
   ```
   SELECT id, difficulty FROM question
   WHERE knowledge_ids @> [knowledgeId]::jsonb        -- GIN(:163, KC containment)
     AND (draft_status IS NULL OR draft_status <> 'draft')  -- 孤儿 draft 排除契约
     AND difficulty >= difficultyMin                  -- 可选 floor
     AND (parent_question_id IS NULL ...)             -- 篇=composite 时
   ORDER BY created_at, id                             -- 无相似度排序
   ```
   单 KC 作用域（`knowledge_ids @>`），纯 scalar，无向量。这是「统一算子」要泛化的原型。

3. **question 表可过滤的权威列**（`src/db/schema.ts`）：`domain`(text, nullable—经 effective_domain 派生)、`kind`(text NOT NULL)、`judge_kind_override`(text，Step 3 后= answer-class)、`knowledge_ids`(jsonb @>，GIN)、`difficulty`(integer NOT NULL default 3，CHECK range)、`draft_status`(text，NULL≡active)、`embedding`(vector(1024)，Phase 0 新增)。

4. **pool-fetch 消费者清单**（grep）：`question-supply/dispatcher.ts`、`quiz/sourcing-sequence.ts`、`ai/tools/query-questions.ts`、`questions/list.ts`、`ai/tools/review-plan-tools.ts`、`ai/tools/write-quiz.ts`、`copilot/server/chat.ts`。各自手写 Drizzle where，**无共享 pool-fetch helper**——这是「统一算子」要收敛的散点。

5. **软维度（错因/掌握/考纲）未物化为可过滤列**：mastery 走 `src/server/mastery/`（state/personalized-difficulty/item-calibration/recalibration，PFA/FSRS 派生）、错因走 attempt 分析（cause-options）、考纲未见专列。要让它们进 WHERE 需先物化（spec §4 标注）。**这是 Phase 1 最重的不确定块，建议拆出或缓做**。

6. **`effective_domain` 是 app-layer 派生，非 SQL 列**（`src/ui/lib/subject.ts:131` resolveEffectiveDomain + `src/capabilities/ingestion/server/tagging.ts:112`）。→ 算子按 domain 过滤**不能直接进裸 WHERE**：要么先 app 层解析出候选 domain 的 KC id 集再传入，要么物化 effective_domain 列。算子接口需把「domain 过滤」建模成「已解析的 knowledge_id 集 / domain 字符串 + app 层预解析」，别假设能 SQL 直筛。

7. **⚠️ 供给/目标引擎 NOT dormant（spec drift）**：`question_supply_nightly` cron 06:00 Asia/Shanghai（`src/capabilities/practice/manifest.ts:196-200`）已 LIVE，经 YUK-372（YUK-361 Phase 8 wire-up）接通：`discoverSupplyTargets`（`target-discovery.ts`，纯发现零写零 LLM）→ `dispatchSupplyTargets`（`question-supply/dispatcher.ts`）→ 派到 sourcing/quiz_gen 队列或标 manual，带 7d fingerprint cooldown + per-run cap 25 成本护栏。**spec §3 / 早期分析称其「DORMANT — 无 production caller」已 STALE**——harvest-then-match 的「matcher drive」seam **已部分活着**。Phase 1 matcher 应**建在这条 live 链上**（用统一 pool-fetch 算子喂 discoverSupplyTargets / dispatcher），不是「唤醒一个 dormant 引擎」。建议 owner 据此校正 spec §3 措辞。

## 建议的 Phase 1 第一增量（最小可证 vertical slice）

**统一 pool-fetch 算子 v0 + 一个消费者迁移 + 首个 hybrid 查询跑通**：
1. 新建 `poolFetch(db, criteria)` 算子：入参 = 权威 scalar 过滤（domain/effective_domain、draft_status active、difficulty band、kind/answer-class）+ KC containment（knowledge_ids @>）+ **可选** `queryEmbedding`（有则 `ORDER BY embedding <=> $vec`，无则退回 created_at）+ limit。复刻并泛化 `queryExistingPool` 的现有谓词（**保留孤儿 draft 排除 + 篇 composite 派生 + difficulty floor**，零行为回归）。
2. 先迁 `queryExistingPool` 一个消费者到算子（证等价 + 不回归），**暂不**接软维度。
3. 证 hybrid：`WHERE <scalars> ORDER BY embedding <=> $queryvec LIMIT k` 跑通（用 Phase 0 已 backfill 的 embedding），一个 db 测试断言相似度排序合理。

软维度物化 + 供给/目标引擎接线（spec §3 称其 DORMANT）= **Phase 1.x 后续增量**，本增量不碰。

## 计划前待决（recon 恢复后 + owner）

- **算子作用域**：单 KC（现状）还是跨 KC/domain 池？hybrid 查询的候选集边界。
- **软维度物化策略**：mastery/错因/考纲 进列 vs 留 view-join vs 算子内 join——哪些 Phase 1 要、哪些缓。
- ~~供给/目标引擎是否唤醒~~ → **已确认 LIVE**（question_supply_nightly 06:00 cron）。真问题改为：统一 pool-fetch 算子如何**插进 discoverSupplyTargets / dispatcher 现有 live 链**（替换/包住它们手写的池查询），而非另起炉灶。
- **embed-on-write 新鲜度依赖**（YUK-393）：matcher 用 embedding，但内容编辑/reparent 后 embedding 陈旧——matcher 上线前要不要先解 YUK-393？

## 下一步

recon agent 恢复后跑完整 Phase 1 surface map（7 消费者逐一 + 供给引擎入口核实），再据本 note + spec §4 升级为逐 task TDD plan（writing-plans）。本增量独立于 kind reshape，可并行。
