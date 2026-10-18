# YUK-1547 admission structured-submit shape + @3 marked reopen runbook

测试门禁票 **YUK-1547**（第一天能用 / W0）。实现目标使付费准入结构化提交通道安全、可审计、
fail-closed，并保留 YUK-1537（#1785 / #1792）的全部语义。

Stage: **第一天能用**。Refs YUK-1537。

## 10-18 TEST 运行证据与根因

真实 TEST 跑批（provider `xiaomi-token-plan` / model `mimo-v2.6-pro`，OpenAI-completions API）：

- 两次 pre-flight 都返回 `{"result": "<JSON string>"}`：强制 tool call 下 MiMo 每次把嵌套
  `result` 对象序列化成字符串。
- 五个 `@2` 运行中：3 个在 `jsonObjectFromModel` 里死于
  `JSON.parse failed: Unexpected non-whitespace character after JSON at position N`
  （完整对象后还有多余结尾字符）；1 个死于 adapter 的原始流式参数严格 JSON 校验；1 个被
  `independent solves disagree: key kind blank_text vs blank_numeric` withhold —— 该 unit 的
  criterion 不是 seeded `blank_key`，没有 `answer_kind` 提示，两个 solver 各自挑了 kind。
- `ai_task_runs` 只存输出 digest，原始字节无法复查 —— 失败证据缺口。

## 变更

1. **删除 `result` envelope。** `mcp__structured_output__submit` 的 tool parameters 就是任务
   输出 schema 本体（solve 输出顶层是 `units`）。`piCustomTool` 接受完整 Zod schema。
   adapter 直接把 submit 调用 arguments 当作结构化输出；字符串形态的 arguments 照旧流向
   capability（不做新启发式），`jsonObjectFromModel` 对字符串先严格 `JSON.parse` 再退回
   brace-slice。严格 raw-JSON 校验、"无 text fallback"、"无 provider re-ask" 全部保留。
2. **失败证据。** adapter 层（原始流式字节严格校验失败等）由 runner 把
   `structured_submit_evidence`（≤4096B 的原始参数 + 全量 sha256 + truncated 标记）写入
   `tool_call_log`，错误文案带 `raw_args_sha256=` → 自然进入 `unresolved_reason`。
   capability 层（成功 terminal 但 schema/parse 失败）由 solve path 以同一 evidence 形状写
   `tool_call_log`（error_reason=`structured_output_parse_failed`），digest 同样进错误文案。
   两层共用 `src/core/raw-arguments-evidence.ts`；无新表、无 migration。
3. **`keysAgree` 跨 kind 比较。** `blank_text` vs `blank_numeric`：numeric 键
   `expected_unit` 为空且**每个** accepted text form 经 `parseBlankNumericText`（与判分
   `numericCorrect` 同一个 NFKC+trim+PLAIN_NUMBER 确定读法；无千分位、无单位）解析并落入
   numeric tolerance ⇒ 一致，铸 **numeric** 键（判分读法不变）。否则冲突。**每个**冲突分支
   的 detail 都带双方值，长度有界（160 字符截断标注）。
4. **`question_admission@3` / `admission@3` 契约。** 传输改变 ⇒ 契约版本提升，与
   `@1`→`@2`（#1785）同模式。applied verdict 继续在 `@1`/`@2`/`@3` 全部 unit 上匹配
   （serving 读、409 门、`QUESTION_ADMISSION_PAID_UNITS`、terminal verification 三个
   policy id）——同内容绝不重复付费。**唯一 marked 例外见下。**
5. **一次性 marked reopen（payment gate）。** job `admission_version:3` 且携带
   `reopen_paid_effect_identity:{unit:'admission@2',input_digest}`（lead-only 清单，普通
   publisher 永远不带）时：
   - claim 路径先锁定并验证 marker 指向的 same-base @2 行：state `unknown`，或 `applied`
     且 `isKindMismatchSolveConflict`（withheld + per_unit `solve_conflict` + kind-mismatch
     detail）——两条都合格才放行；否则 job 报错（applied 非冲突行仍按 terminal applied
     返回，marker 不能覆盖）。
   - entity gate（paid_effect-store 的 `findGateBlocker`）在 marker 下豁免：被点名 @2
     unknown 行（精确 identity 匹配），以及同 base 的 @1 unknown 行（`EXISTS` 子查询要求
     被点名 @2 行真实存在 —— 伪造 marker 不豁免任何东西）。
   - `historicalTerminal` 抑制只在 marker 验证通过后绕过（case b 的 @2 withheld verdict
     自身留的 `failed` verification 行）。
   - 一次发送由 `@3` paid_effect identity CAS + `sending/unknown` 快照拦截保证；旧付费行
     永不 UPDATE。
6. **`scripts/yuk1547-admission-reopen.ts`。** lead-only：preflight 用新 shape（顶层
   `units`）发一次 provider 探测；reopen 模式需 60 分钟内同 routing/schema 的通过回执 +
   恰好 5 条私有 manifest（`group_id`,`base_digest`,`input_digest`），在 family-locked 事务里
   快照旧行 → 重新 pend → 以 marker 入队 `@3`，旧付费行不改。TEST scoped，无自动调用。
7. `QUESTION_ADMISSION_POLICY_ID` pin：`@1`、`@2` 一律拒绝（含 `resolveQuestionAdmissionPolicyId`
   内过时 pin 抛错）。

## Payment-safety 推理（每个 gate 变更）

- **无 marker 的普通 job 行为不变**：applied 扫描返回首个 applied verdict（任何 unit 都
  terminal）；@2/@3 unknown/sending blocker 依然阻塞；`historicalTerminal`、`stale`（非
  当前 unit 不可发送）语义保留。
- **marker 不是从 @2 存量输入推导**、不由 publisher 复制：只读 `reopen_paid_effect_identity`
  job 字段；digest 错误/缺失 → 点名行查找失败 → job 报错。
- **(b) 无 marker 绝不可能**：applied 扫描对 marker 豁免仅当
  `reopenMarkedRowEligibility` 判定 `applied_conflict` —— 非 kind-mismatch 的 solve_conflict
  保持 terminal。
- **@1 unknown 豁免有界**：仅同 base（entity_revision）、仅当 marker 指向真实存在的
  @2 unknown/applied 行（SQL `EXISTS`）。
- **一次发送**：同 digest 的第二个 @3 claim 撞 `sending/unknown` 快照 → `held`；
  `admissionJobId` 含 marker digest，重复脚本入队返回 `null` → 抛错。
- **不同 base/无关 family/digest 错误全部阻塞**：gate 谓词要求同 `entity_revision` +
  family=`question_admission_run` + marker unit=`admission@2` + digest 精确匹配。

## Pre-deploy gates

1. **旧 unit `receipt_ready` 计数 = 0**：`paid_effect` 中 family=`question_admission_run`、
   unit ∈ {`admission@1`,`admission@2`}、state=`receipt_ready` 必须为 0 —— 未落的收据
   先人工 reconcile（脚本事务内强制）。
2. **Policy-pin 检查**：`QUESTION_ADMISSION_POLICY_ID` 不得 pin `@1`/`@2`；未设 ⇒
   `question_admission@3`。
3. **Routing pin**：`AI_PROVIDER_OVERRIDE=xiaomi-token-plan` +
   `AI_PROVIDER_MODEL=mimo-v2.6-pro`；solver B 默认同 pin，`assertModelProfileCapabilityFit`
   + OpenAI-completions 双求解校验。
4. **Preflight**：`pnpm exec tsx scripts/yuk1547-admission-reopen.ts --preflight <receipt>`
   发一次探测（不改 paid_effect），要求恰好一次 submit call、顶层 `units` 严格过 schema、
   合成答案 `blank_numeric 2`。
5. Worker/app 部署带本 PR 的代码后再跑 reopen；manifest 为私有五 identities。

## Reopen 执行

```bash
pnpm exec tsx scripts/yuk1547-admission-reopen.ts \
  --reopen-approved-five <receipt.json> <private-five-identities.json>
# DATABASE_URL 必须显式等于 YUK1547_TEST_DATABASE_URL（TEST 限定）
```

事务内逐组：lock root+lifecycle → 要求 `scoring_admission_state='withheld'` 且未被禁 →
快照旧 @2 行（unit/digest/state/application sha256）→ 校验无 @3 行、无其他 applied
verdict → revision/base/seal 校验 → `owner_hold`→`unverified_rules` 两步 dimension-only
re-pend → `boss.send` 入队 `admission_version:3` + marker。任一校验失败整体回滚。

## Post-run acceptance

- 恰好 5 条 `@3` job 入队，每条对应一条 manifest identity；`boss.send` 无一返回 `null`。
- `@1` 快照行不变（state `unknown` 保留为未决义务）；**无旧付费行被 UPDATE**（脚本无
  `update(paid_effect)`）。
- 每条 `@3` 结果记录 exact `entity_revision`/`input_digest`/`output_digest`（paid_effect +
  `ai_task_runs`）；provider/model/task_run id 可从 `tool_call_log` 与 job `task_run_ids`
  对账。
- 成本如实记录，含 unknown 成本（receipt/attempts 层）。
- 5 条全部 admitted 或带解释 withheld；任何 `pending`/`unknown` 即为失败，**不自动 rerun**
  —— 回到 owner 裁决。
- 剩余 backlog 归属：仍滞留在 `unknown` 的其他 @1/@2 行不在本票解决，属既有 reconcile
  backlog（owner 显式点名）。

## Rollback

- 代码回滚前：`@3` job 对旧代码不可读（`admission_version:3` 不在旧 union ⇒ zod 拒），
  旧代码只能 stale 它们 —— 不要混布。先回滚代码前须确认无 `sending`/`receipt_ready` 的
  `@3` 行；`unknown` `@3` 行按既有 reconcile 流程处理（不可自动 replay）。
- 旧 `@2`/`@1` applied verdict 在 `@3` 下仍 terminal，回滚不撤销 applied 证据。

## 本 PR 未验证项

- 真实 provider 探测与 5 行 reopen 未在本实现 lane 执行（TEST 限定操作，按 runbook 由
  lead 执行）；离线 replay 覆盖七项纯逻辑证据（见 PR body）。
- `tool_call_log` evidence 行写入路径经 typecheck/lint/build 与代码走读核对，未在真实 DB
  运行。
- q31srw8d0u（case b）的 application_json 形状以 10-18 记录重建 matcher，未经真实行验证。
