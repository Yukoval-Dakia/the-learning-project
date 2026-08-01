# Runbook — conjecture-wire dark-loop（YUK-538 ⑬）

> 单元：producer `serveProbeOnce`/`answerProbe`（`src/capabilities/agency/server/conjecture/probe-lifecycle.ts`）+ answer route `POST /api/conjecture/probe/[id]/answer`（`src/capabilities/agency/api/probe-answer.ts`）+ reader `GET /api/admin/conjecture-scores`（`src/capabilities/observability/api/conjecture-scores.ts`）。
> 决策 SoT：`docs/adr/0049-conjecture-wire-dark-loop-producer-consumer.md`。spec：`docs/design/2026-07-04-conjecture-wire-spec.md`。
> 红线：ND-5——probe 生命周期**永不写** FSRS / attempt / θ̂。judge 经 `createDefaultJudgeInvoker().invoke()`（`probe-answer.ts` 的 `POST`），ND-5 边界是 `answerProbe` 而非 dispatch path——invoker 本身 judge-only，零 FSRS/attempt/event 写。
>
> ⚠️ **本行曾写反**（YUK-790 核对修正）：旧版称「经 registry 直调 `resolveJudge(kind).run()`，**不走** `createDefaultJudgeInvoker`」。那是 ADR-0049 §2 记录的 **CRITICAL 缺陷**（PR #705 已修）——base registry 的 semantic `run()` 是 profile-validation STUB，返回 `coarse_outcome:'unsupported'`，走它则每个 free_text probe 都 fail-closed 422、永不写 probe_result。**照旧文改代码会重新引入该 bug。**

owner 现实中靠 admin reader + 结构化日志感知 loop；本 runbook 是最小手动面（expert owner + psql/脚本权限）。

## 检测面（loop 通了吗）

1. **producer 端**——accept conjecture 后是否同步派发了判别探针：
   ```sql
   -- 最近 24h 派发的 probe（draft question，source='mind_probe'）
   -- 注：question 表无 slug 列；知识点是 jsonb 数组 knowledge_ids（非 knowledge_id）。
   SELECT id, kind, knowledge_ids, draft_status, source, created_at
   FROM question
   WHERE source = 'mind_probe'
     AND created_at > now() - interval '24 hours'
   ORDER BY created_at DESC;
   ```
2. **consumer 端**——owner 作答后是否写了 probe_result event + reconcile 是否 mint 了软态 + prediction_score：
   ```sql
   -- probe answer 结果（accepted probe 的判分锚）
   SELECT id, subject_id, task_run_id, action, payload->>'outcome' AS outcome,
          payload->>'resolution' AS resolution, created_at
   FROM event
   WHERE action = 'experimental:probe_result'
   ORDER BY created_at DESC LIMIT 20;

   -- 结构性软态。⚠️ 本轨**待通电**（ADR-0050 §(a)，执行 YUK-794）：当前 reconcile 硬编码
   -- confused_with_kc_id=null，§修正-4 gate 要求具名 KC 才发 confused-with-X，
   -- 故 YUK-794 落地前此查询**返 0 行**。返回空是预期，不是故障，不要据此排查 reconcile。
   -- 列名对齐 schema.ts kc_typed_state：知识点是 subject_id（无 knowledge_id 列），
   -- provenance 是 evidence_event_ids（无 evidence 列），时间是 updated_at（无 created_at 列）。
   SELECT subject_id AS knowledge_id, typed_state, confused_with_kc_id, lifecycle,
          evidence_event_ids, last_evidence_at, updated_at
   FROM kc_typed_state
   WHERE subject_kind = 'knowledge'
     AND typed_state LIKE 'confused-with-%'
   ORDER BY updated_at DESC LIMIT 20;

   -- 单点校准 proper score。payload 键名以 reconcile.ts 写入的为准：brier_model /
   -- brier_baseline / log_loss_model / skill_score_point（**无** 'brier' 键）。
   -- score_basis **不在** event payload 里——它是 admin reader 响应的字段，别在这查。
   SELECT subject_id AS probe_result_event_id,
          payload->>'knowledge_id'       AS knowledge_id,
          payload->>'brier_model'        AS brier_model,
          payload->>'brier_baseline'     AS brier_baseline,
          payload->>'log_loss_model'     AS log_loss_model,
          payload->>'skill_score_point'  AS skill_score_point,
          created_at
   FROM event
   WHERE action = 'experimental:prediction_score'
   ORDER BY created_at DESC LIMIT 20;
   ```
3. **HTTP 面**——answer route 直接测（token 在 `.env` 的 `INTERNAL_TOKEN`）：
   ```bash
   curl -sS -X POST "$BASE/api/conjecture/probe/$PROBE_ID/answer" \
     -H "x-internal-token: $INTERNAL_TOKEN" \
     -H 'content-type: application/json' \
     -d '{"answer_md":"2x·cos(x²)"}' | jq .
   ```
   reader：
   ```bash
   curl -sS "$BASE/api/admin/conjecture-scores" \
     -H "x-internal-token: $INTERNAL_TOKEN" | jq .
   ```

## 红线核验：ND-5（probe 不写 FSRS）

每个 probe 的判分入站后核一次（owner 信任但核验）：
```sql
-- (a) probe source 的 question 永不进 material_fsrs_state。
-- 注：material_fsrs_state 无 question_id 列——它按 (subject_kind, subject_id) 键；
-- subject_kind 现在是 'knowledge'，'question' 是 legacy fallback，故按 subject_id 关联。
SELECT COUNT(*) AS violations
FROM material_fsrs_state m
JOIN question q ON q.id = m.subject_id
WHERE m.subject_kind = 'question' AND q.source = 'mind_probe';

-- (b) 更强的一条（FSRS 已按 knowledge 键，(a) 只覆盖 legacy 键）：probe 永不产 attempt 事件。
SELECT COUNT(*) AS violations
FROM event e
JOIN question q ON q.id = e.subject_id
WHERE e.action = 'attempt' AND e.subject_kind = 'question' AND q.source = 'mind_probe';
```
两条都期望 0。非零 → ND-5 被破，停一切 + 查 answer route 的写路径。

answer route 的隔离保证**不**靠「避开 invoker」——它就是走 `createDefaultJudgeInvoker().invoke()`（`probe-answer.ts` 的 `POST`）。保证来自：invoker 本身 judge-only（零 FSRS/attempt/event 写），FSRS 写在 `submit.ts` 里 judge 调用**之后**的自有代码中，而本 route 不走 submit.ts；判分结果只由 `answerProbe` 写一个 `experimental:probe_result`。付费槽控制另写 `experimental:probe_judge_started`，失败释放时写 `experimental:probe_judge_released`，两者都不是 attempt/FSRS。见 ADR-0049 §2 + 红线守恒矩阵。回归测试 `probe-answer.db.test.ts` 在每条路径断言零 FSRS 行。

## judge kind 与 OAuth lane（multimodal probe）

probe question 的 authored kind 当前是 **`short_answer`**，但 `serveProbeOnce` 会在每个
`mind_probe` question 上显式写 `judge_kind_override='multimodal_direct'`。因此当前 answer
route 对文字与图片答案都走 **`multimodal_direct`**，不是 semantic，也不是尚未接线的
future path。

未设置 override 时，`MultimodalDirectJudgeTask` 按 registry 默认走
`xiaomi / mimo-v2.5`。实际 provider 解析优先级是：vision 调用点传入的
`VISION_JUDGE_PROVIDER`（可选配套 `VISION_JUDGE_MODEL`；当前包括
`multimodal_direct` 等 vision 调用点）> 全局
`AI_PROVIDER_OVERRIDE` / `AI_PROVIDER_MODEL` > registry 默认；因此
`VISION_JUDGE_PROVIDER=anthropic-sub` 或 `AI_PROVIDER_OVERRIDE=anthropic-sub` 都能切到 owner
Claude Max 的 OAuth lane。前者在 OAuth token 缺失时会告警并省略 per-call override，回落到
全局 override 或 registry 默认；不要把 judge kind 与 provider/auth lane 混为一谈。启用 OAuth 时：
- token = `CLAUDE_CODE_OAUTH_TOKEN`。
- token **绝不入 git / 绝不打印**——经 `.env.local` 透传三进程（API / Vite / worker），生产经 compose `.env` 注入 app + worker 两容器（见 CLAUDE.md「Switchable AI provider lane」）。
- judge 子进程 env 由 `runner.buildAgentEnv(authMode:'oauth')` 构造：SET `CLAUDE_CODE_OAUTH_TOKEN`、UNSET `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` + 四个 cloud-provider selector（YUK-365 Finding 1）。

## judge 成本观测

answer route 本身不重复记成本：runner lifecycle 写 `ai_task_runs` 与 `cost_ledger`，judge
invoker 返回同源的 authoritative `task_run_id`；`answerProbe` 将它写入对应
`experimental:probe_result` event envelope。查询必须从 probe result 出发再按 run id
连接，**不能**从 `task_kind LIKE '%JudgeTask'` 反推，否则会混入使用同名 judge task 的
普通练习。

```sql
-- 真·probe 专属：ordinary practice 即使 task_kind/provider/model 完全相同也不会进入。
-- 按需在 probe_runs CTE 内加 created_at / subject_id 过滤。
WITH probe_runs AS (
  SELECT id AS probe_result_event_id,
         subject_id AS probe_question_id,
         task_run_id,
         created_at AS probe_result_at
  FROM event
  WHERE action = 'experimental:probe_result'
    AND subject_kind = 'question'
)
SELECT p.probe_question_id,
       p.probe_result_event_id,
       p.task_run_id,
       r.status AS run_status,
       c.task_kind,
       c.provider,
       c.model,
       c.currency,
       COUNT(c.id) AS ledger_rows,
       ARRAY_REMOVE(ARRAY_AGG(c.id ORDER BY c.occurred_at, c.id), NULL) AS ledger_ids,
       COALESCE(SUM(c.cost), 0) AS total_cost,
       COALESCE(SUM(c.tokens_in), 0) AS total_tokens_in,
       COALESCE(SUM(c.tokens_out), 0) AS total_tokens_out,
       p.probe_result_at
FROM probe_runs p
LEFT JOIN ai_task_runs r ON r.id = p.task_run_id
LEFT JOIN cost_ledger c ON c.task_run_id = p.task_run_id
GROUP BY p.probe_question_id, p.probe_result_event_id, p.task_run_id,
         r.status, c.task_kind, c.provider, c.model, c.currency, p.probe_result_at
ORDER BY p.probe_result_at DESC;
```

`LEFT JOIN` 是故意的：历史 `task_run_id IS NULL`、新调用因 run provenance/digest
持久化失败而由 invoker fail-closed 清空 run id，以及 best-effort ledger 写失败，都会以
`ledger_rows=0` 暴露而不是被静默吞掉。需要精确合计时只纳入
`task_run_id IS NOT NULL AND ledger_rows > 0` 的新链路结果，并继续按 `currency` 分组，
绝不跨币种裸 `SUM`。历史空值不回填；judge 已付费但在写 `probe_result` 前 fail-closed /
失败的调用也没有结果事件，因此本查询诚实回答的是“成功落下 probe result 的可归因成本”，
不是所有尝试过的 probe spend。

⚠️ **旧版此处三重写错**（YUK-790 核对修正）：查的是 `event WHERE action='ai:tool_call'`——该 action **不存在**；工具调用落 `tool_call_log` **表**而非 event 流；且 `tool_call_log.cost` 按设计恒为 0（schema.ts 明注：成本权威在 `cost_ledger`，此列填值会双记）。payload 键 `model`/`input_tokens`/`output_tokens`/`cost_usd` 亦全部不存在。
若显式切到 `anthropic-sub`，成本经 owner Claude Max 订阅（不按 token 计）；ledger 仍保留
run/provider/model/token correlation，但金额是当前 `effectiveCostUsd` 能提供的运营口径，不应
误读为订阅账单的逐调用现金成本。

## 场景 A：accept 了 conjecture 但 reader 看不到 probe

**症状**：accept 成功，`probe_result` / `prediction_score` / `confused-with-X` 三 query 全空。

**根因排查**：
1. `serveProbeOnce` 返回 `cap_reached`（≤3 active 已满）—— tolerated，本轮不派，slot 释放后下轮补。查 active 数：
   ```sql
   SELECT COUNT(*) FROM question
   WHERE source = 'mind_probe' AND draft_status = 'draft'
     AND id NOT IN (
       SELECT subject_id FROM event WHERE action = 'experimental:probe_result'
     );
   ```
   等于 3 → 正常 cap，无需动作。
2. conjecture proposal payload 缺 `probe_md` / `probe_reference_md` → `serveProbeOnce` 抛 `requiredString` → accept 整个 tx rollback → rate event也没写。查 proposal event payload 是否带这两字段；这是 induce 期 bug，非 wire bug。
3. ND-5 隔离被破 → 见上「红线核验」。

## 场景 B：answer route 返 422 fail-closed

**症状**：`POST .../answer` 返 422，body `{"error":"unsupported_judge_route"}`。

**语义**（A5-a）：单一 error code 覆盖三种 fail-closed 触发——(1) judge `coarse_outcome` 是 `partial` 或 `unsupported`（判别探针不 cleanly discriminate，注入 n=1 校准锚会污染软态信号）；(2) probe question `kind` 列 corrupt（非合法 `QuestionKind`）；(3) `judge_kind_override` 列 corrupt（非合法 `JudgeKind`）。三种都 → 探针**保持 active**（slot 未消费），不写 probe_result。owner 可重答（探针还在），或走 admin 直接查/弃。

**不是 bug**——是诚实 fail-closed。若频繁 partial → judge rubric / probe_md 设计问题，回 induce 期调。

## 场景 C：幂等重答返 500

**症状**：同一 probe 答 2 次，第二次返 500 `probe_result_corrupt`。

**根因**：`answerProbe` 幂等路径读到既有 probe_result event 的 `payload.outcome` 不是 `0|1`（或 `resolution` 不是 `confirmed`/`retired`）。说明该 row 被外部直改损坏。查：
```sql
SELECT id, payload FROM event
WHERE action = 'experimental:probe_result' AND subject_id = '$PROBE_ID';
```
若 payload 真损坏（手动改过）→ 这是数据完整性事件，修 row 或软删 probe 让 owner 重答；不要降级幂等校验去 paper-over。

## 场景 D：reconcile 跑了但不 mint 软态

**症状**：probe_result event 在，nightly `reconcileConjecturePredictions` 跑了，但 `kc_typed_state` 没新 `confused-with-X`。

**根因**：reconcile 的 confirmed→mint 路径只在 `outcome=0`（confirmed）时触发；`outcome=1`（retired）的 probe 反驳了猜测，**不 mint**（正确语义）。先核 outcome：
```sql
SELECT payload->>'outcome' AS outcome FROM event
WHERE action = 'experimental:probe_result' AND subject_id = '$PROBE_ID';
```
outcome=1 → 预期不 mint。outcome=0 → **YUK-794 通电前仍预期不 mint**：当前 reconcile 硬编码 `confused_with_kc_id=null`，具名 KC gate 因而不会通过（与上方检测面一致），不是 reconcile 内部故障。YUK-794 落地后若具名 KC 输入完整仍不 mint，再按 reconcile job bug 排查。

## flag 不翻

`MISCONCEPTION_PROMOTE_ENABLED` 保持 OFF（dark default）。wire 只接 probe 生命周期 + reader，不动 promote 闸。翻 flag 是独立 owner 决策（ADR-0036 RT1，hard-confirm 路径），**不在本 runbook scope**。
