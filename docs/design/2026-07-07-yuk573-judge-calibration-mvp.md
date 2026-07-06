# YUK-573 — Judge Calibration MVP (设计草案)

**Status**: APPROVED r3 — 对抗复核绿灯（符合性席 MF1–MF8 全 GREEN、MF6 调和接受；冷眼席无 MUST-FIX 新伤）；r3 随行吸收复核四点，进 TDD
**Date**: 2026-07-07 (r3)
**Lane**: ultrawork Wave 2 Lane E
**Scope**: 两件 report-only 可观测性交付，均不动判分主链路
1. **Judge golden set（两腿）** — (leg A) 归一化层 replay golden：冻结「原始 LLM 输出 → 归一化 JudgeResultV2」离线比对；(leg B) prompt-render snapshot golden：冻结 `getTaskSystemPrompt(task, profile)` 渲染输出 diff。**首发 fixture 全部合成；生产素材经 Deliverable 2 采样链积累后由 owner 脱敏补充**（MF1/MF7 诚实化）。
2. **不同意率采样** — pg-boss 夜间 cron 随机抽样已判 judge event，第二 lane（Opus 订阅）复判，记录 agreement rate（纯观测，绝不改 outcome）；同时兼任 leg A 的生产 golden 素材采集源（MF1 反转方案）。

**非目标**: 不做自动 prompt 优化 / 微调；不改 judge 主链路行为（MF6 的 imageFetchFn 是 additive 参数透传，默认行为 byte-identical）；不碰 `src/server/conjectures/scoring.ts` placeholder stub。

---

## 0. 问题陈述（为什么做）

评测纪律严重不对称：确定性一侧纪律极高（event-sourcing golden set `scripts/capture-golden.ts` + `audit:calibration` θ̂ 回放），但 LLM 输出一侧为零。~35 个 AI task 没有任何 golden set / 回归评测 / drift 检测。`audit:calibration` 验证 θ̂ 数学的前提是 **outcome bit 正确**，而产 outcome bit 的 LLM judge（`StepsJudgeTask` / `MultimodalDirectJudgeTask` / `SemanticJudgeTask`）是全系统被测量最少的组件；prompt 全手写在 `src/ai/task-prompts.ts`，**改一行没有回归网**。方向 B 的全部 payoff 建立在 judge 这颗传感器上。

---

## 1. 关键接地事实（grounding，r2 修正版）

### 1.1 Judge 主链路（纯函数，绝不写 outcome；但吞错）
- **入口**: `judgeAnswer(params): Promise<{ route, result: JudgeResultV2T }>`（`src/server/ai/judges/question-contract.ts:268`）。**PURE** —— 只返回结果，不写任何 event。写 judge/correct/θ̂ event 的是 caller（`submit.ts` / `paper-submit.ts` / `rejudge.ts`）。
- **可注入 `runTaskFn`**: invoker（`src/server/judge/invoker.ts:162`）透传给每条可运行路由。
- **⚠️ 吞错事实（MF3 依据，r1 声明失实处）**: 三条 LLM 路由把 `runTask`/`resolveTaskProvider` 的 throw **内部 try/catch 吞成 `coarse_outcome='unsupported'`**（`question-contract.ts:261-265`、`steps-judge.ts:260-267`、`multimodal-direct-judge.ts:189-195`）。token 缺失**不会** loud throw 到 caller —— 会安静产出 unsupported。
- **vision 图输入**: 原判 steps/multimodal 以 `student_image_refs`（来自 `body.answer_image_refs`，`submit.ts:253`）判分；invoker 透传（`invoker.ts:172/183`）；但 **`JudgeAnswerParams` 无 `imageFetchFn` 注入口**（`question-contract.ts:65-95`），invoker dispatch 不透传，默认 `defaultImageFetch` 直查 db（MF6 依据）。
- **`JudgeResultV2T`**: 判别式 union on `coarse_outcome ∈ {correct, partial, incorrect, unsupported}`。
- **强制路由**: `question.judge_kind_override`（rejudge 先例）。

### 1.2 Attempt / judge event（采样来源）
- **judge event**: `action='judge'`, `subject_kind='event'`, `subject_id=<answer event id>`, `payload.coarse_outcome` + `payload.judge_route`（写路径 `submit.ts:595-620` / `rejudge.ts:191`）。**`task_run_id: null`**（`submit.ts:621`），payload 无 provider —— 原判 lane 事后不可考（MF5 依据）。
- **answer event**: `action='attempt'`（卷）/ `action='review'`（散）；payload 持久化 `answer_md`/`user_response_md` **及 `answer_image_refs`**（`submit.ts:564`，MF2 依据）；`subject_id` = question id。
- **重建 judge 输入**: judge event → answer event → question row + `answer_md` + **`answer_image_refs`** + `resolveSubjectProfileForKnowledgeIds`。
- **newest-wins**: 申诉改判产生新 judge event（`rejudge.ts:172-200`），旧判被 supersede —— 采样须按 answer event 取最新 judge（MF4② 依据）。
- **caused_by 复用事实**: appeal event 亦以 judge event id 为 `caused_by_event_id` —— 裸 caused_by 查重会把被申诉过的 judge 误判为已采样（MF8 action-filter 依据）。

### 1.3 Provider lane（三根杠杆，r2 补全）
- **杠杆 1 — per-call override**: `runTask(kind, input, ctx)` 的 `ctx.override` > 全局 env > registry 默认（`providers.ts:192`）。
- **杠杆 2 — 全局 `AI_PROVIDER_OVERRIDE`**: 进程级切 lane。
- **杠杆 3 — `VISION_JUDGE_PROVIDER`（r1 遗漏，MF5 依据）**: `vision-judge-config.ts` 的 per-route env，在 `steps-judge.ts:256` / `multimodal-direct-judge.ts:185` 调用点注入 `ctx.override`。其 **degrade-to-undefined** 模式（oauth token 缺失时回落默认 lane）是本设计**有意反向选择**的对照（见 §3.5）。
- 三根杠杆叠加意味着「原判也可能跑在 Opus lane」是被支持的运行模式 —— 复判 lane 同源坍缩必须可标记（§4 lane 快照）。
- `anthropic-sub` = OAuth 订阅 lane（`CLAUDE_CODE_OAUTH_TOKEN`，默认 model `claude-opus-4-8`）。`resolveTaskProvider` 在 token 缺失时 throw —— 但该 throw 只在 **judge 路由 try/catch 之外**调用时才可见（§3.4 pre-flight 正是为此）。**token 绝不入库不打印。**

### 1.4 pg-boss job + kill switch
- **JobDecl**（`src/kernel/manifest.ts:42`）: `{ name, schedule?, queue, load }`；handler 工厂 `(db) => (jobs) => Promise<void>`。
- **kill switch 模板**（`research_meeting_agent_nightly.ts:240`）: handler 首行严格 `!== '1'` early-return。
- **queue 'agent'** = `EXPIRE_AGENT=7200s`。**⚠️ 幂等含义**: 2h expire 窗内 handler 中途死亡会被 redeliver，`boss.schedule` 无 singleton —— 纯 SELECT 查重可双写（MF8 依据）。
- 采样 job 归 practice manifest（判分域）。

### 1.5 观测记录与 golden 素材（r2 修正）
- `writeEvent` 唯一 INSERT 路径 + `parseEvent` barrier；非 reserved `experimental:*` 走通用 escape hatch 零注册。
- **⚠️ golden 采集无源事实（MF1 依据，r1 设计塌方处）**: `ai_task_runs`（`schema.ts:611-634`）**无输出文本列**，input 只存 `input_hash`；三个 judge task `allowedTools:[]`/`needsToolCall:false`，`writeToolCallLog` 只在 tool-use block 触发（`runner.ts:760/1052`）→ **judge run 零 `tool_call_log` 行**；judge event payload 只存归一化后字段。**现存表无处可取 judge 原始 LLM 输出** —— 生产 golden 素材必须由本 MVP 自己开始采集（§3.2 第 3 步）。
- **幂等约束事实（MF8 依据）**: event 表对 `caused_by_event_id` 只有普通 index（`schema.ts:838`），无唯一约束。
- observe-only 先例: `experimental:auto_enroll_observed`（`ingest_at=now` opt-out、系统侧 actor、零 domain 写）。
- `audit:schema` 审计 schema **列**的 write path，不审 payload key、不审 index —— 本设计零新表零新列（新增一条 partial unique **index**，见 §4.2），audit:schema 零负担不变。

### 1.6 Admin 只读端点先例
- `/api/admin/conjecture-scores`: 薄路由 → 纯 drizzle 读模型 → `Response.json`，fail-closed，零写零 flag。
- **Postman 对账（S6）**: 新增路由必须同步 `postman/api-endpoints.json` + `pnpm gen:postman`（CLAUDE.md 硬要求）。

---

## 2. Deliverable 1 — Judge golden set（两腿，r2 重构）

### 2.1 目标失效模式（诚实拆分，MF7）
| 变更类型 | 由哪条腿护住 |
|---|---|
| 改归一化/解析/路由分派逻辑（`normalizeSemanticResult` 阈值、`StepsLlmOutput→JudgeResultV2` 映射、`extractJsonObject` 切片、parse-fail→unsupported 兜底、route dispatch） | **leg A** replay golden（确定性） |
| 改 judge prompt（`task-prompts.ts` 任何一行） | **leg B** prompt-render snapshot（确定性 diff；改动被 gate 抓漂移 + 以 snapshot diff 形式在 PR review 强制可见） |
| 换 model / model 行为漂移 | **不在两腿覆盖内**（离线 replay 对 model 数学上不可见）。由 **Deliverable 2** agreement 监测承接 + follow-up owner-run input-replay 工具（§8） |

**r1 失实修正**: 冻结 LLM 输出的 replay 对 prompt/model 变更不可见（改 prompt 后 replay 的仍是旧冻结文本，永远绿灯）。leg A 的诚实定位 = **确定性归一化层回归网**；「prompt 变更回归网」由 leg B 承担；两腿合并才回应 issue 的「prompt / model 变更时 replay 比对」意图（model 面见上表第三行）。

### 2.2 leg A — 归一化层 replay golden

**素材来源（MF1 反转方案）**: 现存表无 judge 原始输出（§1.5）。素材链 = **Deliverable 2 采样 job 把复判 lane 的原始 LLM 输出文本存进观测 event payload**（`rejudge_raw_output`，§4）→ owner 定期从 calibration event 挑选、脱敏、手工提交为合成 fixture。合法性：被测对象是 parse/normalize/dispatch 逻辑，**lane 无关** —— Opus raw 输出与 mimo raw 输出对归一化层是同类输入。**首发 fixture 全部手工虚构合成**（不等采样积累），生产素材随采样链后续补充。

**(a) Fixture 格式** — `scripts/judge-golden/*.json`（committed，全合成/脱敏）
```jsonc
{
  "version": 1,
  "capturedNote": "SYNTHETIC — hand-authored or desensitized-from-calibration-events; never raw production data",
  "cases": [
    {
      "id": "semantic-correct-floor-01",
      "description": "语义判分：correct 分数 floor 钳位（0.85）边界",
      "question": { "id": "q_synthetic_1", "kind": "short_answer", "prompt_md": "…", "reference_md": "…",
        "rubric_json": { "required_points": ["…"] }, "choices_md": null,
        "judge_kind_override": "semantic", "knowledge_ids": [] },
      "answer_md": "…",
      "student_image_refs": [],                    // vision case 填合成 ref（配 imageFetchFn 桩）
      "subject_profile_id": "wenyan",
      "frozen_llm_output": "{…raw JSON…}",         // OPTIONAL（S3：accelerator case 无 LLM 输出）
      "llm_must_not_be_called": false,             // S3：steps accelerator case 置 true
      "expected": { "route": "semantic", "coarse_outcome": "correct", "score": 0.9, "confidence": 0.8 }
    }
  ]
}
```
- **覆盖矩阵（S3 边界+对抗升级）**: semantic / steps / multimodal_direct 三路由 ×
  - 阈值边缘 score：semantic correct floor **0.85**、partial cap **0.84** / floor **0.01**、incorrect 恒 **0**；
  - prose-wrapped JSON + 尾部垃圾（打 `extractJsonObject` 首尾大括号切片）；
  - 缺字段 Zod-fail → `unsupported`（带判别断言，见 (b)）；
  - steps `signal_verdicts` 长度与 `expected_signals` 不匹配；
  - steps **accelerator 分支**（`final_answer_match`→partial 免 LLM）：`frozen_llm_output` 省略 + `llm_must_not_be_called: true`（桩被调用即 drift）；
  - **≥1 组无 `judge_kind_override` 的 case**：用真实 profile 走 `resolveQuestionJudgeRoute`（纯函数零 IO），`expected.route` 断言分派 —— 使「含路由分派」声明为真（MF6）。
- 脱敏保留结构 quirk（prose 包裹、字段缺失形态），只换内容。

**(b) Replay 工具** — `scripts/judge-golden-reaudit.ts`（`pnpm audit:judge-golden`）
- 纯函数 `reauditJudgeGolden(fixture)`（CLI-gate 可 import，仿 `golden-reaudit.ts`）。
- 每 case: 桩 `runTaskFn = async () => ({ text: case.frozen_llm_output })`（`llm_must_not_be_called` case 的桩 = 记录调用并计 drift）；**db = throwing Proxy sentinel**（MF6 修正：任何属性访问 throw 带唯一 marker `__JUDGE_GOLDEN_DB_TOUCHED__`）；vision case 注入 **`imageFetchFn` 桩**（返回合成图 bytes）—— 依赖 (d) 的 additive 透传。
- **⚠️ 吞 db-touch 的暴露机制（r1「碰即 loud throw」措辞失实，照实改）**: judge 路由会把 Proxy throw 吞成 `unsupported`（§1.1），**不会** loud throw 到 harness。暴露方式 = 确定性 drift：(i) `expected` 非 unsupported 的 case → outcome 不匹配即 drift；(ii) `expected` **是** unsupported 的 case（S3 parse-fail 分支）→ harness **额外断言** `evidence_json`/`feedback_md` 不含 `__JUDGE_GOLDEN_DB_TOUCHED__` marker 且含 parse-fail 判别特征（如 `validation_error` 存在）。**调和声明（供复核确认）**: 这是对 MF6「fixture expected 恒非 unsupported」字面的有意精化 —— S3 要求覆盖 parse-fail→unsupported 分支（归一化层的 load-bearing 兜底），blanket 禁 unsupported 会砍掉该覆盖；改为「unsupported-expected case 必须断言 unsupported *原因*判别特征 + marker 不存在」，MF6 的目标（被吞 db 触碰不可能 false-pass）与 S3 的覆盖同时成立。
- 比较只含 judge 逻辑字段（`route`, `coarse_outcome`, `score`, `confidence`, unsupported 判别特征），**剥离 `capability_ref.version`**。
- **判别键逐路由核实（复核吸收 1）**: steps/multimodal 的 parse-fail evidence 键形态可能与 semantic 的 `validation_error` 不同 —— TDD 写判别断言时以各路由源码实际键名为准，不照抄示例。结构保证：被吞 db 触碰只能走 throw-swallow 路径产 `{error: <msg>}`（无 parse-fail 键），parse-fail 产 `{validation_error, raw_text}` 类键 —— 「parse-fail 键存在」无法被 db 触碰伪造。
- report-only exit 0，`--strict` 非零；unit test 断言全 CLEAN → 进 `pnpm test` gate。

**(c) Capture 工具（重新定源，MF1）** — `scripts/capture-judge-golden.ts`（`pnpm capture:judge-golden`）
- ~~读 ai_task_runs / tool_call_log~~（**r1 方案作废：两源均无输出文本**，§1.5）。
- r2: 读 **`experimental:judge_calibration_sample` event**（payload 携 `rejudge_raw_output` + question/answer 定位 id），join question/answer event 重建完整 case，打印 fixture skeleton 供 owner 脱敏挑选。owner-run against prod；输出**不**自动进 repo；脚本打印醒目脱敏告警。

**(d) 前置 additive 改动（MF6）**: `JudgeAnswerParams` 加可选 `imageFetchFn`（签名对齐 steps/multimodal 运行器既有的 image-fetch 注入点，实施时以 `steps-judge.ts` 现有 injectable 为准）；`invoker.ts` 两处 vision dispatch（`:166-187`）透传。纯 additive —— 不传时默认 `defaultImageFetch`，主链路 byte-identical。

### 2.3 leg B — prompt-render snapshot golden（MF7 拉进本单）
- **对象**: `getTaskSystemPrompt(kind, profile)` 的渲染输出（**首参是 kind 字符串非 registry 对象**，`task-prompts.ts:919`，复核吸收 4②），三个 judge task kind × 全部 registry committed profile（`subjectProfiles`，纯函数零 IO 零成本）。
- **Snapshot**: `scripts/judge-golden/prompts/<TaskKind>.<profileId>.md`（committed）。
- **工具**: `scripts/judge-prompt-reaudit.ts`（`pnpm audit:judge-prompts`）—— 默认 check：重渲 diff vs 冻结 snapshot，report-only exit 0，`--strict` 非零；`--write` 显式重生成（prompt 改动是有意时跑，diff 进 PR review —— 这就是 prompt 变更回归网的形态）。
- unit test 断言全 CLEAN → 进 `pnpm test` gate。

---

## 3. Deliverable 2 — 不同意率采样（r2 修订）

### 3.1 形态
practice 域 pg-boss 夜间 cron（默认 OFF），随机抽样已判 LLM-route judge event，第二 lane 复判，写 report-only 观测 event（兼任 leg A 素材采集）。**绝不** touch attempt outcome / mastery / θ̂ / draft_status / FSRS。

### 3.2 采样核心 `runJudgeCalibrationSample(db, deps)`
1. **选样（MF4 三修）**:
   ```sql
   -- 概念 SQL；实施用 drizzle
   WITH latest AS (
     SELECT DISTINCT ON (subject_id) *          -- ② 按 answer event 取最新判（newest-wins，防 superseded 双采）
     FROM event
     WHERE action = 'judge'
       AND created_at >= now() - interval '<WINDOW_DAYS> days'
       AND payload->>'coarse_outcome' IN ('correct','partial','incorrect')
       AND payload->>'judge_route' IN ('semantic','steps','multimodal_direct')  -- ① LLM 路由白名单（kt_estimate_nightly 先例）；确定性路由（exact/keyword/unit_dimension）复判恒同意、白吃 BATCH_MAX
     ORDER BY subject_id, created_at DESC
   )
   SELECT * FROM latest j
   WHERE NOT EXISTS (
     SELECT 1 FROM event s
     WHERE s.caused_by_event_id = j.id
       AND s.action = 'experimental:judge_calibration_sample'   -- ⚠️ action 过滤是对 rejudge 裸 caused_by 先例的 load-bearing 偏离：appeal event 亦以 judge id 为 caused_by（§1.2），照抄裸查重会把被申诉过的 judge 误判为已采样
   )
   ORDER BY random()                              -- ③ Q4 裁决=随机（消 recency-slab 与活跃度反相关偏差；成本上限不变）
   LIMIT <BATCH_MAX>;
   ```
2. **逐样重建 + 复判**（per-item try/catch 隔离）:
   - 重建: answer event payload → `answer_md` + **`student_image_refs = answerPayload.answer_image_refs`（MF2）**；question row；`resolveSubjectProfileForKnowledgeIds`。
   - **vision 样本 skip 规则（MF2）**: `judge_route ∈ {steps, multimodal_direct}` 且 answer payload **无 `answer_image_refs` 字段**（pre-persistence 旧行，信息面不可复原）→ 计 `skipped`，不复判不写行；字段存在（含 `[]`）→ 原样传入（信息面与原判一致）。图 bytes 经 `defaultImageFetch`（采样 job 持真 db，可用）。
   - 复判: `judgeAnswer({ db, question: {...q, judge_kind_override: <原判 payload.judge_route>}, answer_md, student_image_refs, subjectProfile, runTaskFn: rejudgeRunTaskFn })`。
   - **`rejudgeRunTaskFn`（S1 修订：不包 `defaultRunTaskFn`，防契约折叠丢 task_run_id）**: 直接 `import { runTask } from '@/server/ai/runner'`；closure 形如
     ```ts
     const slot: { task_run_id?: string; raw_text?: string } = {};
     const rejudgeRunTaskFn = async (kind, input, ctx) => {
       const result = await runTask(kind, input, {
         ...(ctx as object),
         override: { provider: cfg.REJUDGE_PROVIDER, model: cfg.REJUDGE_MODEL },  // override 字面量必须在 ...ctx 之后（S5 钉序：vision 路由会在 ctx 里注入自己的 override，spread 序决定谁赢）
       });
       slot.task_run_id = result.task_run_id;
       slot.raw_text = result.text;               // MF1 素材采集：parse 前的原始文本
       return result;                              // 结构性满足 { text }
     };
     ```
   - **unsupported 处理（MF3②）**: `rejudgeOutcome === 'unsupported'` → 计 `skipped_unsupported`，**绝不写 agreed=false 观测行**（对齐 `rejudge.ts:113` unsupported-as-upheld 语义 —— unsupported 是「复核不可用」不是「不同意」）。
   - 比对: `agreed = (rejudgeOutcome === priorOutcome)`；另记 `bit_agreed = (outcomeBit(rejudge) === outcomeBit(prior))`（θ̂ 传感器关心的位，bit(correct|partial)=1）。
3. **写观测 event**（§4；携 `rejudge_raw_output` ≤20KB 截断带 marker、`rejudge_task_run_id`、lane 快照）。
4. **收尾写一条 run-summary 观测 event**（复核吸收 3，mass-skip 自曝面）: `action='experimental:judge_calibration_run_summary'`（独立 action：manifest events.actions 登记、`caused_by_event_id: null`、与 sample 的 partial unique index 不同 action 互不约束、同样 `ingest_at` 预填 report-only），payload = `{ sampled, agreed, disagreed, skipped, skipped_unsupported, errors, batch_max, window_days, rejudge_provider, rejudge_model, vision_judge_provider_at_sample, ai_provider_override_at_sample }`。**为什么**: skip/errors 只进 worker log 时，系统性失效（`answer_image_refs` 回归→全 vision skip / REJUDGE lane 持续 unsupported→全 skipped_unsupported）在 admin 面与「样本天然稀少」不可区分，工具无法自曝已坏；run summary 让 admin 读模型把 healthy-but-sparse 与 systematically-skipping 分开。
5. 返回 `{ sampled, agreed, disagreed, skipped, skipped_unsupported, errors }` 供 handler log。

### 3.3 复判路由（Q2 裁决：维持沿原判路由）
`judge_kind_override = 原判 payload.judge_route` —— 同 rubric 同路由下唯一能隔离 model 变量的干净对照。裁决前提 = MF2（同图）+ MF3（不掺假 disagree）+ MF4（只采 LLM 路由）+ MF5（同源可标记）全部落地。

### 3.4 handler + 注册
- `buildJudgeCalibrationSampleHandler(db, deps)`:
  1. kill switch：`process.env[JUDGE_CALIBRATION_SAMPLING_ENABLED] !== '1'` → log + return。
  2. **batch 级 pre-flight（MF3①）**: 进采样循环**前**裸调 `resolveTaskProvider('SemanticJudgeTask', { provider: cfg.REJUDGE_PROVIDER, model: cfg.REJUDGE_MODEL })`（在 judge 路由 try/catch **之外**，throw 可见）—— token/config 缺失 → **整个 handler 抛出**，pg-boss 记失败可见。若无 pre-flight，throw 会被路由吞成 unsupported，worker 漏配 token（YUK-365 Finding 2 原班失效面）时每晚安静产出成批 unsupported（在 r1 设计下 = 假 disagreed 行；r2 下 unsupported 已不写行，但 pre-flight 仍必要 —— 否则失效静默为「零样本之夜」而非可见失败）。
  3. `runJudgeCalibrationSample`；catch → log + rethrow（幂等由 §4.2 唯一索引守底）。
- practice manifest jobs +1: `{ name: 'judge_calibration_sample', schedule: { cron: '10 6 * * *', tz: 'Asia/Shanghai' }, queue: 'agent', load: … }`。

### 3.5 配置（`judge-calibration-config.ts`）
| env | 默认 | 说明 |
|---|---|---|
| `JUDGE_CALIBRATION_SAMPLING_ENABLED` | 未设=OFF | 严格 `=== '1'` |
| `JUDGE_CALIBRATION_REJUDGE_PROVIDER` | `anthropic-sub` | per-task override，不碰全局 |
| `JUDGE_CALIBRATION_REJUDGE_MODEL` | `claude-opus-4-8` | |
| `JUDGE_CALIBRATION_BATCH_MAX` | `20` | **每 cron-tick** 上限（MF8 后语义精确化） |
| `JUDGE_CALIBRATION_WINDOW_DAYS` | `7` | 选样窗 |

**显式反向选择声明（MF3①）**: 本 job **禁止** `vision-judge-config.ts` 的 degrade-to-undefined 回落模式（token 缺失时静默回默认 lane）。主判分链路 degrade 是「宁可判不了也别挡学习」；校准 job 的存在意义就是第二 lane 对照 —— lane 不可用时唯一诚实行为是 **fail loud**（handler throw），绝不静默换 lane 或写观测行。

### 3.6 Cost 口径（S2 照实修订）
- **oauth lane `cost_ledger` 恒 $0**（`ANTHROPIC_SUB_FLAT` 全零费率）—— `/api/cost/today` **看不到**本 job spend；可观测的是 `ai_task_runs` 计数 + tokens_in/out（provider=anthropic-sub）。
- **真闸** = `BATCH_MAX`（每 cron-tick ≤20 次 Opus 单-shot 判分；MF8 唯一索引杀重试放大）+ kill switch 默认 OFF。
- **真实成本**落在与 owner 共享的 Claude Max 订阅 rate limit —— 夜间 06:10 错开 owner 交互时段以减争用。

---

## 4. 观测记录（零新表零新列 + 一条 partial unique index）

### 4.1 Event 写形状
```ts
await writeEvent(db, {
  id: newId(),
  session_id: null,
  actor_kind: 'system',
  actor_ref: 'judge_calibration',
  action: 'experimental:judge_calibration_sample',   // 非 reserved → 通用 barrier（Q3 裁决维持）
  subject_kind: 'event',
  subject_id: originalJudgeEventId,
  outcome: null,
  payload: {
    original_outcome, rejudge_outcome, agreed, bit_agreed,
    original_judge_event_id, question_id, answer_event_id,
    rejudge_route, rejudge_confidence,
    rejudge_provider, rejudge_model,
    rejudge_task_run_id: slot.task_run_id ?? null,   // S1（accelerator 免 LLM 路径为 null）
    rejudge_raw_output: truncate20k(slot.raw_text),  // MF1 素材采集（≤20KB + 截断 marker；免 LLM 路径 null）
    // ── MF5 lane 快照（采样时点 env 快照；原判 lane 事后不可考，如实标 unknown）──
    original_provider: 'unknown',
    vision_judge_provider_at_sample: process.env.VISION_JUDGE_PROVIDER ?? null,
    ai_provider_override_at_sample: process.env.AI_PROVIDER_OVERRIDE ?? null,
    same_lane_suspected,   // 推断原判 lane（vision 路由: VISION_JUDGE_PROVIDER ?? AI_PROVIDER_OVERRIDE ?? 'xiaomi'；semantic: AI_PROVIDER_OVERRIDE ?? 'xiaomi'）=== REJUDGE_PROVIDER
    sampled_at: iso,
  },
  caused_by_event_id: originalJudgeEventId,
  task_run_id: slot.task_run_id ?? null,
  ingest_at: now,          // opt out memory outbox
  created_at: now,
});
```
skipped / skipped_unsupported / errors **不写 per-sample 行**（进 handler log 计数 + §3.2 第 4 步的 run-summary event 聚合计数）—— per-sample 观测面只含真实双判对照，run-summary 承担 mass-skip 自曝。写入点局部 Zod 校验 payload 形状（防御，不占 reserved 名）。practice manifest `events.actions` + `'experimental:judge_calibration_sample'` + `'experimental:judge_calibration_run_summary'`。

### 4.2 幂等 = DB 强制（MF8，r1 SELECT 查重降级为性能层）
- **手写 migration**（`drizzle/0017` partial-index 先例）:
  ```sql
  CREATE UNIQUE INDEX event_judge_calibration_sample_unique_idx
    ON event (caused_by_event_id)
    WHERE action = 'experimental:judge_calibration_sample';
  ```
- 写入捕 **23505** unique_violation → 当已采样跳过（`writeEvent` 的 `onConflictDoNothing` 只 target PK `event.id`，其它唯一约束违反照常 throw —— per-item catch 收口）。
- 覆盖场景: AGENT 档 2h expire 窗中途死亡 redeliver / `boss.schedule` 无 singleton 的并发投递 —— SELECT 查重（§3.2 第 1 步）是性能优化，唯一索引是正确性保证（重复采样污染分母 + 击穿 BATCH_MAX 的路径被 DB 层关死）。
- **「零新 schema」口径偏离声明**: 新增的是 **index 非列** —— `audit:schema`（审列 write path）零负担不变；migration 走 `pnpm test:migration` smoke。

### 4.3 Admin 只读端点（唯一暴露面）
- `GET /api/admin/judge-calibration`（observability manifest +1）→ `loadJudgeCalibrationStats(db)`：
  - **headline `agreement_rate` 剔除 `same_lane_suspected=true` 子集**（MF5），该子集单列计数；
  - 分层 `by_route` / `by_original_outcome`；**任一分层格 n < MIN_N（常量，默认 5）→ `{ status: 'insufficient_data', n }` 而非裸比率**（S4）；headline 同受 MIN_N 门；
  - 读模型按 `caused_by_event_id` **DISTINCT 兜底**（MF8 边带）；
  - 响应携 `note: 'agreement ≠ accuracy（第二 judge 非 ground truth）'`（S4）；
  - **same_lane 推断时效声明（复核吸收 2）**: 响应另携 note 显式声明「`same_lane_suspected` 推断基于**采样时点** env 快照 —— owner 在选样窗内翻过 lane（如原判期 `AI_PROVIDER_OVERRIDE=anthropic-sub`、采样时已 unset）时推断失准，同源样本可能混入 headline 抬高 agreement；逐样本行留 `rejudge_provider` + 双 env 快照，可事后重算」。根治（原判 judge event payload 记 provider）属主链路写，§8 follow-up；
  - **run-summary 健康面（复核吸收 3）**: 读最近 N 条 `experimental:judge_calibration_run_summary`，暴露 `recent_runs: [{sampled, skipped, skipped_unsupported, errors, at}]` —— healthy-but-sparse（runs 有、skip 低、样本天然少）与 systematically-skipping（runs 有、skip 占满 batch）在 admin 面可区分；
  - `agreed` 与 `bit_agreed` 双口径并列。
- **复判 run 掺水声明（S1）**: 复判 run 与生产 judge run 共享 `task_kind` —— admin runs/failures 等既有读面把它们当生产信号会掺水。复判 run id 全集可由 calibration event `rejudge_task_run_id` 识别；本读模型可选 join `ai_task_runs` 校验实际 lane（payload.rejudge_provider vs runs.provider 不一致 = config drift 信号）。**改造既有 admin 读面的排除逻辑出本单 scope**，在读模型 + 本 doc 声明，follow-up 记 §8。
- 薄路由 + 纯 drizzle 读模型，仿 `conjecture-scores.ts`。**无前端 UI**。**postman spec 同步 + `pnpm gen:postman`（S6）。**

---

## 5. Report-only 红线保证机制（r2 照实改写）

| 保证 | 机制 |
|---|---|
| 复判不改 outcome | 只调 `judgeAnswer`（PURE）；绝不调 `handleRejudge` / 写 `action∈{judge,correct,attempt,review}` event / 碰 mastery/θ̂/FSRS/draft_status |
| 唯一写面 | 采样 job 唯一 `writeEvent` action 恒 = `experimental:judge_calibration_sample`；测试断言运行后除该 action 外零 event 写、mastery/item_calibration/state_snapshot 零变化 |
| golden replay 零副作用 | db = throwing Proxy；**判分路由会把 Proxy throw 吞成 unsupported（不 loud throw）** —— 暴露机制 = 确定性 drift + unsupported-判别断言（§2.2(b)；r1「碰即 loud throw」措辞已照实修正） |
| token 失效不静默 | **handler batch 级 pre-flight 在路由 try/catch 之外裸调 `resolveTaskProvider` → throw 使整个 handler 失败（pg-boss 可见）**；复判 unsupported 一律 skipped、绝不写 agreed=false（r1「缺失 loud throw」声明已照实修正为「路由内吞、handler 外抓」两段式） |
| 观测事件不污染记忆 | `ingest_at=now` opt out memory outbox |
| 幂等 | **partial unique index ON event(caused_by_event_id) WHERE action='experimental:judge_calibration_sample'（DB 强制）** + 23505 捕获跳过；SELECT 查重仅性能层；action 过滤防 appeal caused_by 串键 |
| lane 隔离 | per-call `ctx.override`（spread 序钉死：override 在 `...ctx` 后）；不设不读全局 env 做路由；同源坍缩以 lane 快照 + `same_lane_suspected` 标记，headline 剔除 |
| token 安全 | `CLAUDE_CODE_OAUTH_TOKEN` 只经 `resolveTaskProvider` → runner subprocess env，绝不入库不打印 |

---

## 6. 改动文件清单（r2）

**新增**
- 本 design doc
- `scripts/judge-golden/*.json`（leg A 合成 fixture）+ `scripts/judge-golden/prompts/*.md`（leg B snapshot）
- `scripts/judge-golden-reaudit.ts`（leg A replay）
- `scripts/judge-prompt-reaudit.ts`（leg B check / `--write`）
- `scripts/capture-judge-golden.ts`（r2 定源：读 calibration event；owner-run，输出不提交）
- `drizzle/00XX_judge_calibration_sample_unique.sql`（MF8 手写 partial unique index）
- `src/capabilities/practice/jobs/judge_calibration_sample.ts` / `judge-calibration-config.ts`
- `src/capabilities/practice/server/judge-calibration-sample-core.ts`
- `src/capabilities/observability/api/judge-calibration.ts` + `server/judge-calibration.ts`
- 各 `*.unit.test.ts` / `*.db.test.ts`

**修改**
- `src/server/ai/judges/question-contract.ts` — `JudgeAnswerParams` 加可选 `imageFetchFn`（**additive**，MF6）
- `src/server/judge/invoker.ts` — 两处 vision dispatch 透传 `imageFetchFn`（**additive**，MF6）
- `src/capabilities/practice/manifest.ts` — jobs +1、events.actions +1
- `src/capabilities/observability/manifest.ts` — routes +1
- `postman/api-endpoints.json` + 跑 `pnpm gen:postman`（S6）
- `package.json` — scripts：`audit:judge-golden`、`audit:judge-prompts`、`capture:judge-golden`

**仍不碰** `src/ai/registry.ts` / `src/server/ai/runner.ts`（Lane F 冲突面；`runTask` 以 import 消费不改动）。

---

## 7. 测试计划（TDD，先 RED）
- **leg A**（unit）: fixtures 全 CLEAN；篡改 expected → drift；db-Proxy marker 判别断言（unsupported-expected case）；accelerator case 桩被调用 → drift；无 override case 路由分派断言。
- **leg B**（unit）: snapshots 全 CLEAN；篡改 snapshot → drift。
- **采样核心**（db）:
  - (a) 观测行正确性：payload 含 agreed/bit_agreed/raw_output/task_run_id/lane 快照；
  - (b) **红线**：运行后无 judge/correct/attempt/review 新 event、mastery/item_calibration/state_snapshot 零变化。**断言 scope 注意（复核吸收 4①）**: 勿写成「除 event 外任何表零新行」—— 复判每样本**预期**产生 ai_task_runs / cost_ledger 新行（$0），红线断言只锚 event 表 action 集合 + mastery/item_calibration/state_snapshot 三面零变化；
  - (c) 幂等：同 judge 二次运行不重复；**模拟并发双写 → 23505 捕获路径**；**被申诉过（appeal caused_by 同键）的未采样 judge 仍可采**（action 过滤 load-bearing 测试）；
  - (d) BATCH_MAX 生效；
  - (e) **S5 spread 序**：设 `VISION_JUDGE_PROVIDER=xiaomi` 走 steps 路由复判，spy 断言收到 `ctx.override.provider === REJUDGE_PROVIDER`；
  - (f) **token 缺失 → handler throw 且零观测行**（pre-flight 生效）；
  - (g) 复判 unsupported → skipped_unsupported，零观测行；
  - (h) vision 样本 answer payload 无 `answer_image_refs` 字段 → skipped；
  - (i) 确定性路由（exact）judge event 不入样（白名单）；
  - (j) superseded 旧判不入样（newest-per-answer）。
- **kill switch**（unit）: env≠'1' → no-op 零写。
- **admin 读**（db）: MIN_N insufficient_data；same_lane 剔除 headline + 单列计数；DISTINCT 兜底；除零。
- **migration**: `pnpm test:migration` 收 MF8 index DDL。
- 全量 gate: `pnpm typecheck / lint / audit:schema / audit:partition / audit:profile / audit:draft-status / test / build`。

---

## 8. 遗留风险 / follow-up（不扩 scope；coordinator 落 Linear）
- **model 变更面无离线回归**（MF7 表第三行）: owner-run input-replay 工具（冻结输入过活 LLM 重放）。
- **原判 judge event payload 记 provider**（复核吸收 2 根治项）: 属主链路写（submit/paper-submit judge event payload +1 键），落地后 same_lane 推断可换成逐样本精确值。
- **既有 admin runs/cost 读面的复判 run 排除改造**（S1 声明层落地，本单只在新读模型 + doc 声明）。
- **Wilson CI / drift 报警阈值**（S4 维持 follow-up；MVP 只有 MIN_N 门 + 双口径计数）。
- 非 judge task（tagging/extraction）golden 扩展。
- fixture 素材随采样链积累后的 owner 脱敏节奏（capture 工具已备）。
- 可能与 Lane F rebase（registry/runner 零改动已最小化冲突面）。

## 9. 判词裁决记录（r1 §9 四问关闭）
1. golden 首 leg = 输出归一化 **认可**，措辞诚实化 + **prompt-render leg 拉进本单**（→ §2 两腿结构）。
2. 复判**沿原判路由维持**（前提 MF2/3/4/5 落地，→ §3.3）。
3. `experimental:` 通用 escape hatch **维持**（单 writer + report-only + 局部 Zod + manifest 声明）。
4. 倒序窗口**否决 → 随机**（→ §3.2 ①③）。
