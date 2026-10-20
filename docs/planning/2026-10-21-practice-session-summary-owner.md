# practice 收编 session summary 运行器 —— server 领域操作退出（YUK-1570）

状态：**已实施**（`13a4b65c6`，后随主线集成合入本分支）。归属审查依据：
`server-exit-domain-and-reads-v2.md`（e9e1a76d 封档）G1 组与本 lane 逐组
归零路径 `…/YUK-1570/56637f4a…/server-domain-operation-exit/`。

## 事实

`runSessionSummary`（268 行）是完整复习域 AI 操作：会话守卫/幂等 skip →
本场 review events → effective verdict/cause 合成 → `SessionSummaryTask`
→ 统计断言过滤 → `UPDATE learning_session.summary_md`。唯一调用方是
practice 的 pg-boss job（`buildSessionSummaryHandler`，manifest LLM-tier
队列注册），TaskSpec 已在 `practice/tasks/session-summary.ts`——实现
滞留 `src/server/session` 是纯历史位置问题（session 模块本应只剩
envelope/状态守卫）。server→capability 深边禁止（serverToCapabilityDeep
= 0 硬门）排除了"留在 server 供 practice 经 public 调"的伪方案。

## 变更（一次原子 commit）

| 文件 | 操作 | 说明 |
|---|---|---|
| `src/capabilities/practice/server/session-summary.ts` | 新建（rename 91%） | 实现逐字迁移；`getFailureAttempts` 改取 kernel 真身（`knowledge/public.ts:25` 仅再导出 `kernel/read-models/failure-attempts`）；`RunTaskFn` 绑定 capability-local `PracticeTaskRunFn`（`server/task-runtime.ts`，与 `BoundRunTaskTextFn` 同签名） |
| `src/capabilities/practice/jobs/session_summary.ts` | 修改 | 2 行 import 改指 + `makeRunTaskTextFn` → `makePracticeTaskTextRunFn`（同默认参/签名/异常传播的直通别名，非 shim） |
| `src/capabilities/practice/tasks/session-summary.ts` | 修改 | 2 处注释路径改指（comment-only） |
| `src/server/session/summary.ts` | 删除 | 未经 `session/index` namespace 导出，无 barrel 改动 |

## 不变项（调度/时序/留痕）

- manifest `session_summary` job 注册、`enqueueReviewSessionSummary`
  （env-gated + best-effort dispatch,`session-operations/review-session.ts`）
  不动；`contract-epoch/jobs.ts` 键不动。
- 幂等：`summary_md` 已写 → `skipped:already_summarized`；失败路径在 job
  handler（catch→log→rethrow→pg-boss retry）语义逐字不变。
- receipt：`runTaskFn` 内 `ai_task_run`/`tool_call_log` 留痕不变；
  status 枚举与 job 日志行不变。
- `learning_session.summary_md` 单列 UPDATE 写权随迁——该列是派生标注
  列，不在 ADR-0005 status 单写者不变量内；schema-writes 审计按字段查写
  路径，写路径仍在故无 allowlist 变更。

## 边界账本（以 audit 实测为准）

- 预期：`practice→session` 7→6、`practice→ai` 63→62、
  `capabilityToServer` 406→404；`crossCapabilityValue` ±0、SCC 不变、
  serverToCapabilityPublic −1（session→knowledge 旧边消失）。
- `decrease` 按 `--tighten` 机制如实入账；新 `capability→kernel` value
  边（4 条 kernel read-models）按 edgeRecords 1:1 登记（父已授权）。
- baseline JSON 由本 lane 按授权更新；`pnpm audit:capability-boundaries`
  实测为最终判定。

## 后续残余（不在本 commit）

practice→session 残余边逐组路径见 lane 文档 §3：tutor 桶（solve-session/
detail → 新 tutor-session ops)、stream 绑定（→ review-session ops)、
placement-advance（环证据下建议合法残余）。写模块本体
（tutor/review/placement.ts）迁移是 owner 级决策（ADR-0005 重钉 +
server 侧 orphan/durable 消费方 + db.test 随迁批准）。
