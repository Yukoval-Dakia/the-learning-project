# Runbook — conjecture-wire dark-loop（YUK-538 ⑬）

> 单元：producer `serveProbeOnce`/`answerProbe`（`src/capabilities/agency/server/conjecture/probe-lifecycle.ts`）+ answer route `POST /api/conjecture/probe/[id]/answer`（`src/capabilities/agency/api/probe-answer.ts`）+ reader `GET /api/admin/conjecture-scores`（`src/capabilities/observability/api/conjecture-scores.ts`）。
> 决策 SoT：`docs/adr/0049-conjecture-wire-dark-loop-producer-consumer.md`。spec：`docs/design/2026-07-04-conjecture-wire-spec.md`。
> 红线：ND-5——probe 生命周期**永不写** FSRS / attempt / θ̂。judge 经 registry 直调（`getDefaultRegistry().resolveJudge(kind).run()`），**不走** `createDefaultJudgeInvoker`（attempt 域耦合 wrapper）。

owner 现实中靠 admin reader + 结构化日志感知 loop；本 runbook 是最小手动面（expert owner + psql/脚本权限）。

## 检测面（loop 通了吗）

1. **producer 端**——accept conjecture 后是否同步派发了判别探针：
   ```sql
   -- 最近 24h 派发的 probe（draft question，source='mind_probe'）
   SELECT id, slug, knowledge_id, draft_status, source, created_at
   FROM question
   WHERE source = 'mind_probe'
     AND created_at > now() - interval '24 hours'
   ORDER BY created_at DESC;
   ```
2. **consumer 端**——owner 作答后是否写了 probe_result event + reconcile 是否 mint 了软态 + prediction_score：
   ```sql
   -- probe answer 结果（accepted probe 的判分锚）
   SELECT id, subject_id, action, payload->>'outcome' AS outcome,
          payload->>'resolution' AS resolution, created_at
   FROM event
   WHERE action = 'experimental:probe_result'
   ORDER BY created_at DESC LIMIT 20;

   -- reconcile auto-mint 的结构性软态（owner-invisible，需双读）
   SELECT knowledge_id, typed_state, evidence, created_at
   FROM kc_typed_state
   WHERE typed_state LIKE 'confused-with-%'
   ORDER BY created_at DESC LIMIT 20;

   -- 单点校准 proper score（brier / log_loss / skill_score_point）
   SELECT subject_id, payload->>'brier' AS brier,
          payload->>'score_basis' AS basis, created_at
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
-- probe source 的 question 永不进 material_fsrs_state
SELECT COUNT(*) AS violations
FROM material_fsrs_state m
JOIN question q ON q.id = m.question_id
WHERE q.source = 'mind_probe';
-- 期望 0。非零 → ND-5 被破，停一切 + 查 answer route 是否误用了 invoker 路径。
```
answer route 的隔离保证靠 `probe-answer.ts` import `getDefaultRegistry` + `resolveJudge`（**不** import `createDefaultJudgeInvoker`）。回归测试 `probe-answer.db.test.ts` 在每条路径断言零 FSRS 行。

## judge kind 与 OAuth lane（multimodal probe）

probe question 的 kind 由 conjecture 诱导期决定。当前 conjecture engine 产 **`short_answer`** kind → `defaultJudgeKindForQuestion` 解析到 **semantic judge**（local，无 OAuth 依赖）。

**multimodal probe**（kind 带图 → `multimodal_direct` judge）是 follow-up，未在本波接线。一旦启用：
- `multimodal_direct` judge 走 **OAuth lane**（`AI_PROVIDER_OVERRIDE=anthropic-sub`，owner Claude Max，token = `CLAUDE_CODE_OAUTH_TOKEN`）。
- token **绝不入 git / 绝不打印**——经 `.env.local` 透传三进程（API / Vite / worker），生产经 compose `.env` 注入 app + worker 两容器（见 CLAUDE.md「Switchable AI provider lane」）。
- judge 子进程 env 由 `runner.buildAgentEnv(authMode:'oauth')` 构造：SET `CLAUDE_CODE_OAUTH_TOKEN`、UNSET `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` + 四个 cloud-provider selector（YUK-365 Finding 1）。

## judge 成本观测

answer route 本身**不**记成本——judge 的 `run()` 是纯函数，LLM 调用成本经 judge runner 内部的 AI 任务日志落地（`src/server/ai/log.ts`，evidence-first 既定基建）。查 probe 判分成本：
```sql
SELECT subject_id, payload->>'model' AS model,
          payload->>'input_tokens' AS in_tok,
          payload->>'output_tokens' AS out_tok,
          payload->>'cost_usd' AS cost, created_at
FROM event
WHERE action = 'ai:tool_call' AND payload->>'tool' LIKE '%judge%'
ORDER BY created_at DESC LIMIT 20;
```
若 `multimodal_direct` OAuth lane 启用，成本经 owner Claude Max 订阅（不按 token 计），日志只记 invocation 不记 cost_usd。

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
outcome=1 → 预期不 mint。outcome=0 仍不 mint → reconcile job 内部 bug（见 `reconcile.ts`，非本 wire scope）。

## flag 不翻

`MISCONCEPTION_PROMOTE_ENABLED` 保持 OFF（dark default）。wire 只接 probe 生命周期 + reader，不动 promote 闸。翻 flag 是独立 owner 决策（ADR-0036 RT1，hard-confirm 路径），**不在本 runbook scope**。
