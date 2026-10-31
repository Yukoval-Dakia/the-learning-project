# 公开逐段正文持久恢复（YUK-1413 / YUK-1473）

阶段：帮助靠谱；同时提供第一天能用的学习伙伴恢复契约。契约：已公开正文在 provider、Stop 或终稿收口失败后仍能恢复；正文不是工具成功、未付费或可安全重试的证据。

本片基于 `06b4e6bc8097282130fc7b0e522a9cb6bdb4c1dd`。只改后端、必要契约和生成接口，不改 UI、companion 或 subtask-events。没有 schema 迁移、第二日志、registry 或运行入口。

## 公开 wire

原 `copilot_run.delta` 仍只有 `payload: {text: string}`；transport `event_id` 仍为真实 `job_events.id`，不改 seq 含义。原 REPLY / FAILED / DONE payload 和 turns AI 行增加可选字段：

```ts
public_prose?: {
  version: 1;
  text: string;
  status: 'streaming' | 'completed' | 'interrupted' | 'failed';
  last_event_id: number;
  failure?: {
    kind: 'provider_rejected' | 'execution_failed' | 'finalization_failed'
      | 'cancelled' | 'execution_unknown';
    http_status?: 400;
  };
}
```

`text` 只累计 `createCopilotProseStream` 净化后、经原 `publishCopilotRunProgressEvent` 事务提交的 DELTA。按 `business_table=copilot_run`、原接受输入的 `run_id=business_id` 隔离；按真实 id 去重、排序。`last_event_id` 是纳入正文的最大真实 delta id，无正文是 0。它不是模型 seq、终态事件 id 或新 cursor。不得从 SDK 全文、terminal candidate、reasoning、内部 comments、工具 raw 结果构造正文。终态后的晚到 delta 不再改变正文。

消费端按 `(run_id,event_id)` 去重。streaming 或 failed/interrupted snapshot 覆盖该 run 的累计增量段，仅合并水位之后的唯一 delta，不能把 snapshot 再 append；换 run/session 不共用缓存。原 SSE Last-Event-ID 回放机制不变。

## 成功正文显示优先级

completed 始终显示原 sealed `reply_md`（实时 REPLY）或 turns 的原 `text`。保留原 finalizer 的 proposal disclosure、correction、primary_view 储存说明。`public_prose.text` 只记录公开 delta、水位与状态；成功时不能覆盖 sealed 正文、追加到正文，或为它改签 receipt。两份文本可以不同。

新成功回复把 sealed `reply_md` 和 `public_prose` 存在同一原 reply marker；terminal owner 从这一个 marker 在同一事务投影 REPLY / DONE。turns 从该 reply payload 读取同一对象。DONE 沿原契约不重复携带 `reply_md`，其配对正文为同 run 的 REPLY。

`status=completed` 单独不能证明 sealed 正文存在。恢复 reader 不从成功 delta 伪造完整回答：若仅有公开流却无 reply 行，会明确显示“成功回复正文缺失，暂时无法恢复完整回答。”；不会生成可用于纠正 chip 的 `reply_event_id`。新 marker 的成功写入仍沿原成功路径，不以公开正文授予成功。

## 失败、Stop 与执行未知

| 原执行事实 | public_prose 状态 / failure | 正文 |
| --- | --- | --- |
| 正常成功 | completed | sealed reply_md / turns.text |
| 可信结构化 provider 400 | failed / provider_rejected + http_status:400 | 有公开正文保留原字节；无正文显示批准的 400 文案 |
| 其它明确执行失败 | failed / execution_failed | 有公开正文保留；无正文为安全失败说明 |
| 成功返回但 finalizer 拒绝 | failed / finalization_failed | 有公开正文保留；不拿通用未封存提示替换 |
| Stop，原工具 drain 已结算 | interrupted / cancelled | 已公开正文；无正文为停止说明 |
| drain 不明、过期 fence / worker 恢复不明 | interrupted / execution_unknown | 已公开正文；执行未知仍明确、不自动重跑 |

可信 400 只沿原 `StreamCollectResult.failure={kind:'provider_request_rejected',httpStatus:400}` 传播。无正文文案为：**模型服务拒绝了请求(400)，具体参数原因尚未定位，本次未完成回答**。不从 error string、HTTP 文案或 trace 数猜 400，不输出原错误、参数、key。新 FAILED 的 error 使用安全固定说明，原 durable_failure / paid / trace / receipt 继续独立保留。

失败/中断时，原 reply commit owner 从持久 delta 重建正文，忽略内存 partial、terminal candidate 和工具 summary 对正文的替代。最终 receipt 仍只在其原 digest 与实际正文匹配时保存；不为 public_prose 改签。primary_view 继续需要原有效 finalization 权威，不能由公开正文授予。turns 的 tool_calls / tool_operations / subagent 状态仍来自原权威投影，不因 partial 缺 receipt 隐藏真实工具回执。新 public_prose metadata 和在途合成行不加入 forModel reader。

## 原 owner、事务与恢复

- `copilot-execution.ts` 保留原净化通道，额外传递原结构化 failure；不改 provider 配置或调用。
- `publishCopilotRunProgressEvent` 仍在原 settlement advisory lock 内校验 terminal / cancel / marker 后提交 job event；内存 onDeltaAccepted 仅提交成功后通知。commit 后本进程回调丢失也不影响持久正文。
- `conversation-writes.ts` 在原 reply marker commit 中冻结正文和状态。执行 owner、Stop、ambiguous recovery 均复用原 writer，原 outcome / durable reason / checkpoint_safe 保持独立。
- Stop 先赢锁：后续 delta 被拒；delta 先提交：Stop marker 必须包含它。publish 未提交/回滚：不计入正文和水位。无需在内存猜测这一竞态。
- marker 成功、suffix 失败：原 redelivery / reconcile 读 marker 后只修 terminal suffix，仍不调用模型/工具。成功修 REPLY + DONE 原事务，失败修原 FAILED。
- 原 queue live / unknown 与 45min + grace 判断不变。ambiguous 恢复仍无 checkpoint，不因为有正文变成成功、paid 未发生或安全重试。
- 原 30 天 prune 增加必要保护：公开正文尚未冻结到 reply marker 时保留该 run 的原事件流（含 fence、cancel、terminal），覆盖恢复长期不可用。冻结后 delta/普通进度沿原 TTL 删除；带 public_prose 的原 REPLY / DONE / FAILED 保留，保证 SSE 在 TTL 后仍以真实原 id 恢复终态。turns 始终可从 domain reply marker 恢复，不依赖这些 delta 常驻。旧 marker 未冻结时保留现有真实流，不迁移、不猜造历史正文。

## 旧行与身份

无 public_prose 的旧行沿原 reply_md / terminal / turns 合同，不识别提示文案猜协议。如果保留的原 delta 能按 run 身份严格归属，可恢复其公开正文与最大真实 id；状态只用原 outcome、durable_failure 或 terminal 事件。缺 delta 证据就不编文本，也不把缺字段解释为 completed。

在途 turns 没有 reply 行时，仅针对本 session 的真实 ask/chip 根投影已提交公开正文。合成 AI 行 `event_id=copilot_public_prose_${run_id}`，`run_id` 仍是原接受输入；这是快照行身份，不是 domain event 或 SSE cursor，无 `reply_event_id` / checkpoint 权限。真实 reply 出现后使用原 reply 行，原 UI owner 按 run 合并。用户撤回/策略过滤仍沿原 reader。

开放 11 PR 鲜核：#2192@0a65af75fde5575ffbfc7712eb025976f73a74cb 的 turns.ts 仅顶部 conversation import 移至 `./conversation-lifecycle`；本片不取该 PR，也不改该 import 的意图，集成时保留迁移。#2157 corrective chip、#2196 UI、#1969 冻结产品均不纳入本片。

## 验证与交付边界

工件：`/Volumes/YukovalSBak/yukoval-projects/tlp-status/review/yuk1413-public-prose-20261030`。静态门的命令、真实 exit 和原日志见该目录 `gates.json` / 日志；不把 baseline 或未执行项记成通过。最终静态门全部 exit 0；lint 实报 168 warnings，未更改 baseline。API client 与 Postman 生成各 exit 0。

测试代码 0 改、测试 0 跑。DB/SQL 执行、provider、Mem0、业务 HTTP、浏览器、容器、runtime、paid、重放、部署、恢复实测均 NOT_RUN。竞态/TTL 为源码路径实现及静态核对，不是运行验收。唯一首次独立 R1、exact-head CI 与 UI consumer 整合归父；draft PR 不代表产品验收。本片不调查已有 89636… 的非法参数样本。没有本片范围外已验证的新 actionable follow-up；原 400 归因、UI 与运行验收仍归既有 YUK-1413 / YUK-1473，不另造重复项。

### 本地门结果

| 门 | exit | 原日志 |
| --- | --- | --- |
| api-contracts | 0 | `api-contracts.log` |
| api-client-usage | 0 | `api-client-usage.log` |
| provider-attempt-truth | 0 | `provider-attempt-truth.log` |
| typecheck | 0 | `typecheck-final.log` |
| lint | 0 | `lint-final.log` |
| build | 0 | `build-final.log` |
| capability-boundaries | 0 | `capability-boundaries-final.log` |
| architecture-deepening | 0 | `architecture-deepening-final.log` |
| learner-copy | 0 | `learner-copy-final.log` |
| api-client | 0 | `api-client.log` |
| provider-lanes | 0 | `provider-lanes.log` |
