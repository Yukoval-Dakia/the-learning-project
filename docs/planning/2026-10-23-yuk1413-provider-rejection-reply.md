# 模型拒绝请求时保留确定性失败回复（YUK-1413）

2026-10-23，已批准的非 UI 源码片；交付阶段：第一天能用。目标是沿现役 Copilot consumer，在可信的主模型 HTTP 400 拒绝发生后，由原 reply-finalization 在生成同源 receipt 前选择安全失败正文。

## 固定基线与授权

- worktree：`/Users/yuqi/.t3/worktrees/the-learning-project/t3-45189280`；初始 `t3/45189280@ee4b92bea329dde7d88609469e217dd2bb473c1d` clean。
- 正常 fetch 后旧 HEAD 落后 origin/main 272 commits；新分支 `feat/yuk-1413-provider-rejection-reply-20261023` 从实际 main `122121f697ddfa8e7887886edcdd39832e421ee2` 创建，旧 T3 ref 保留。父 stage1-lead 与 PR2017 树没有写入。
- fresh 开放 PR 四面交集只有 `#1964@fd50e76ae40ef04db05b7d8640dc456d7f05a139` 的 runner 注释 patch。父又核该 PR 的 adapter/sdk-types 相交为注释。本片不取外线 branch，不代表其 writer 已释放，保留其删除历史/承重理由意图。
- 原批准四产品面之外的 adapter/sdk-types 及 runner 接收点由协调精确补批，原票 comment `1674791a-89c3-4f08-a70a-8460685ee7de`。settlement 正文优先透传由父随后明确批准，包含合法空串；仅改该原函数的选择表达式和相应说明。
- 原故障事实只采信父已封存结论；未读 DB/日志、未重放原 unknown-cost run。被拒的具体参数仍 UNKNOWN，费用不声明为零。

## 真实 consumer 与唯一封存链

1. `src/server/ai/pi-agent-adapter.ts`：只有 root agentLoop 的原模型调用端口增加局部关联。每次 root `streamFn` 调用建立独立 fetch 闭包；调用原 fetch 一次、传同一参数，保留其返回的实际 Response，原样交还同一个 Response。子 agent 仍用原 `this.streamFn`，不经过该闭包。
2. 同一次模型调用原 stream 的 `result()` promise 完成时，只读观察失败 assistant 对象。先注册观察再交回原 stream，未增加 iterator、替换/缓冲原流或等结果后再开始消费。只有本次实际 Response.status=400、只有一次 fetch，且其它完整性条件都成立，才把 literal 400 绑定到该 assistant 的 WeakMap key。
3. 原 terminal 构造点只对 `lastAssistantMessage(finalMessages)` 查同一对象身份。对象复制失配、无 assistant、abort/cap 都不携字段。原 `piTerminalResultFrame` 仅在已有 `final.stopReason === 'error'` 分支携带安全字段；原 usage/cost/errors/成功/其它失败分支不变。
4. `src/server/ai/sdk-types.ts`：`SDKResultError` 只有新增纯类型 `provider_request_rejection?: { http_status: 400 }`，无 raw error/body/request/key。`runner.ts` 复用既有 `onResultError` typed 回调，在原失败已结算的 partial return 透传 `failure: { kind: 'provider_request_rejected', httpStatus: 400 }`；abort 不透传。原 error、task_run_id、usage、cost、settlement guard 全保。
5. `src/capabilities/copilot/server/copilot-execution.ts`：只对 partial 把安全 failure 交给现有 finalizer，并传空 terminal 防止半程草稿成为 clean terminal。
6. `src/capabilities/copilot/server/reply-finalization.ts`：原 failClosed 在生成正文与 receipt 前选择 `模型服务拒绝了请求(400)，具体参数原因尚未定位，本次未完成回答`。沿用原 trace/已完成工具身份、proposal disclosure、空 candidate、accepted=false、无 primary view；原成功内容、更正/泄题/呈现校验不变。
7. `src/capabilities/copilot/server/copilot-run-settlement.ts`：`handleDurableFailure` 只将已传入的 `preparedReply.text` 作为权威 replyText，包含合法空串；未提供 preparedReply 时旧 partial/fallback 字节不变。原 preparedReply、同一个 receipt 原样交给原 writeCopilotReply，避免旧 partialText 覆盖正文使 receipt 被丢弃。jobs、取消分支、marker、锁、fence、终态、paid/error/投影顺序不变。

没有新 publisher、第二回复或 receipt 后换文案；run/task/caused_by 身份与一次封存仍由原 durable owner 持有。实时草稿进度机制不变，最终 durable 失败正文优先使用原 finalizer 的封存结果。

## 正向证据与保 unknown 的边界

正向来源是 **本次 root 原 fetch 实际返回的 Response + 同次 stream 完成的失败 assistant + 最终 root assistant 同一对象引用**，不是 query.latest、seq、时间、同 model 或错误文本。

既有 snapshot 只负责拒绝歧义：start 在 root stream 调用前，end 在同次 result 完成观察内，不能在消费已排队的 message_end 时才取 end。要求 start 所有既存请求已结束、两端均无 dropped、本次仅增加一个请求/一个 dispatch；最后 retained record 为受控 undici response_received/http400、fetch 已 resolve、headers/wire 已结束，且无 signal abort/timeout/error，status 与实际 Response 一致。它们不替代 root 请求身份。

多 fetch/重试、多 dispatch/redirect、含其它响应状态、父子混合、旧请求仍未结束、snapshot 截断、缺失或未完结、对象复制失配、无 assistant、abort/cap，不能证明时均字段缺失。root 本地 onPayload 拒绝而 child/旧 turn 曾 400 不能被借用。当前保守边界会让部分实际 400 继续走 unknown，不声称覆盖全部 provider400。未知错误仍走原通用失败回复，不解析 provider body 或任意错误/模型文本猜码。

只保留 query 内临时引用，不新建 wire/body 采集、日志或持久 identity；未改 payload/send/retry/timeout/预算/paid。uncapped、无自动重试和 failed/unknown 区分保留。

## 规模登记与验证

`scripts/capability-boundary-baseline.json` 只追加真实 sourceSizeRecords：runner 从 1478 到 1490，base blob `9a2fe852c2e5073f4eda36eded1dd9ce81182d80`；adapter 从 2051 到 2125，base blob `e80dff53956931495437f788dd95ae94cfb1e4c3`。保留原模块调用/terminal 责任才能维持 invocation 和对象身份闭包，不拆 shim；无新文件超过 1500 行，无新增依赖债边，未改 audit/gate/豁免/阈值。blob 是 Git 固定对象引用，未手算 hash/seal。

- 依赖：本树一次 frozen install exit 0，1050 包缓存复用、下载 0，lockfile 未改。经 host heavy.sh，Node old-space 3072，本 lane 串行。
- 准备阶段 typecheck 首轮 exit 2（本地 StreamResult Pick 漏新字段），修复后 exit 0；初轮 lint exit 1（新文案格式），仅格式修正。一次额外 lint 参数调用错误保留在日志，不能作为产品通过证据。
- 最终 typecheck / lint / build / 必要静态 audit：执行结果随后登记；日志在本树 `.cache/yuk1413/`。这些仅是静态/构建证据。
- tests/断言脚本、DB、provider、新请求、原 run 重放、浏览器、容器、配置、重启、部署及 paid：NOT_RUN。
- 首次独立 R1 / exact-head CI / Linear capture 由父负责；本线不自开新 child/review、不 watch/poll/resolve/merge。

最小可审 TEXT 与实际构造说明在 `/Volumes/YukovalSBak/yukoval-projects/tlp-status/review/stage1-yuk1413-copilot-failure-20261023/implementation-handoff/minimal-provider-rejection-text.md`。源码接通不代表 TEST 已部署或原故障已完成运行接受；未知参数修复不在本片。
