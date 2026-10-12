# DOCX agent 材料与草稿工具（YUK-1404）

本次按 owner 后续指令替换同一 Draft PR #1703 的正则路线，服务「第一天能用」的完整录入契约。
基线 `160fd972cdb136902456e07a0f33058359436327`。不 merge、不部署、不用真实 R2 或旧 Mac 数据库、不执行付费 provider。
旧 UI 复核方案仍留在原工作区，七个未提交文件另封存 `/tmp/yuk1404-agent/paused-ui-160.tar.gz`；未纳入本次工具链。

## 已接通的路径

1. `/api/ingestion/docx` 使用既有外部资源预检及 `DocxConverter`，完整保存原 DOCX、清理后的转换副本、Markdown、PDF、有序页面图和全部内嵌媒体。
   `source_document` 保存文件 manifest 与摘要，session 的 `source_asset_ids` 仍只放有序页面，保持原有 page_index 语义。
2. 既有 extraction 队列的 DOCX 分支调用 `DocxIngestionTask`，经统一 Pi runner 挂载 registry DomainTools。初始上下文只有会话/来源摘要与文件数量，不一次注入全部页面。
3. 每次运行从 session 绑定的 manifest 恢复独立临时目录，核对 DB 所有权与实际字节 SHA。文件名仅作标签，磁盘路径由服务端生成；工具只接受本次资产 ID。没有任意路径、URL、shell 或凭据访问。
   原 DOCX/PDF 留存用于恢复；agent 的文本/视觉读面是 Markdown、可选布局 JSON、页面图和内嵌图。工作区退出即清理，重试从持久材料重建。
4. `read_docx_source` 支持清单、分段文本与图片/局部放大。图片作为 Pi 原生 image tool result 返回；共享工具日志只记录资产/摘要/区域，不记录 base64。
5. `edit_docx_drafts` 支持 inspect、upsert、check、commit。upsert 立即调用 session owner 保存真实草稿及 canonical event，稳定 key / revision 防止重试重复创建。
   同一 mount 复用 `get_question_block_structure`、`update_prompt`、`add_option`、`set_question_type`、`split_stem`、`merge_questions`、`reassign_figure`，并在现有事务外加本 session 的范围检查。
6. 工具校验 schema、节点/图引用、重复所有权、已读文本范围、完整页面/媒体查看和覆盖声明；编辑后覆盖声明失效。
   agent 决定题目、选项、小问、布局与配图语义。检查能发现记录缺口，不能证明模型没有漏题或判断正确。
7. 同 session 活跃任务用 Postgres advisory lock 防重复执行；进程断开释放锁。agent 失败记录 failed，原材料及已落草稿不删除，经原 extract 重试恢复。
   完成投递可重放而不重复建题。没有 DOCX OCR/正则 fallback；未完成、空题或未知材料明确保留。
8. partial 可导入已核对且内容/版本一致的草稿；未选草稿及未解决源材料阻止 session 提前终结。正式入库仍经过既有导入、答案契约和准入链。
   当前切片没有新增 partial 会话的自动续跑调度，也没有自动正式入库；原有 failed 重试已接通。

`markdown-segment.ts`、其专用 `docx-ingestion.ts` 写入路径及正则边界测试已删除。
历史 text DOCX 的人工 confirmation 校验保留，只兼容已有数据，不是新 agent 的确认路径。

## 解析器边界

未自研 OCR、版面或坐标提取。现有 Pandoc/LibreOffice/PDFium 继续转换；仓库已有 GLM OCR / Tencent OCR 路径，但新 DOCX 分支不会在 agent 失败后调用它们回退。
`DocxConverter.docxToMarkdown` 仅新增可选 `layout: { format, bytes }`：按字节保留成熟解析器的无损布局 JSON，可包含版本、配置及坐标约定，并经现有文件工具分段读取。
本次没有安装或集成 Docling、PaddleOCR、MinerU。父任务负责单份同卷隔离评估；PDF 视觉基准与原 DOCX/media 保全不依赖选型。

## 免费验证与六阶段验收（01b986ca 历史切片）

只替换原 `import.db.test.ts` 的一个关键 case。外部 converter 返回合成材料。初版 `f667718d` 仅模拟工具调用；本次改为真正调用中央 `runTask` → `PiAgentAdapter` → Pi `agentLoop`，只替换 provider 的 `streamSimple` 响应流。实际执行材料存储、PDFium 页面渲染、工作区重建、registry 工具编译、Pi 原生图片结果、session/题块事务、canonical event、失败/重试、活跃重复投递和 import。
临时本地 PG + 内存 blob；未读取真实卷、未发 provider HTTP 请求、未调用付费模型。两个真实 task-run 分别为 failure/error 与 success/end_turn；数据库费用字段如实保留 unknown/null，不把受控流中的零用量当供应商费用证据。此前暴露的 JSONB 键序比较及 Date 工具 schema 问题已修复后重跑同一 case，没有扩大测试矩阵。

| 阶段 | 本轮合成证据 | 真实学校试卷 |
|---|---|---|
| 完整提取 | 可控 agent 保存两题；六份材料字节摘要一致；不证明识别质量 | 未运行新 agent，不能沿用旧 d481 的 32 题结果 |
| 图片引用 | 本会话 image tool 有像素；越界句柄/题块拒绝；一张图明确未归属 | Q12/13、Q31/32 仍需同卷视觉核验 |
| 题型/选项 | 草稿 kind 与 A/B 保留；无正则识别 | #1658 题型/选项正式保全依赖未重复实现 |
| 草稿确认 | 中断后两草稿保留，重试不重复；空题/未决项可见 | 未验收 |
| 正式入库 | 一题正式入库；一草稿保留；ignored=0；session=partial | 未验收 |
| 可答题状态 | 正式题仍为 withheld / unverified_rules / container_only | 未验收，不能由导入成功推导 |

历史工具模拟证据：`docs/planning/evidence/2026-10-12-yuk1404-docx-agent.json`。本次真实 Pi 循环证据：`docs/planning/evidence/2026-10-12-yuk1404-docx-pi-loop.json` 与同名前缀日志归档。
本地执行范围是该单 case、typecheck、lint/ratchet、build、task census、test policy 和必要 API/Postman 生成。整套测试只交给推送后的 exact-head CI Gate。

## 下一次真实模型运行的最小依赖（预算闸门前的历史说明）

- 一份获准使用的原卷，或等价的脱敏完整 source package；不能只给预切题文本。
- 核对实际 provider/model 绑定和视觉+工具能力。TaskSpec 默认 `xiaomi / mimo-v2.5`，运行配置可覆盖；不能把默认当作实跑事实。
- 该历史版本配置为 48 次迭代、240 秒、`maxCost=0.5`、transientRetries=0。后续只读检查确认聊天/Pi 不消费 maxCost，故该 0.5 从未构成成本保护；当前请求前闸门见下节。
- 记录代码版本、输入/输出摘要、真实 task-run ID、实际模型、用量/费用依据，再分别对账上述六阶段。

旧「每周 20 USD」不作为本次调用授权。Linear 由父任务维护，本轮不重复扫描或写入。PR 保持 Draft；历史独立审查预算不重启，也不把旧审查当作覆盖本次迁移。

## 架构 CI 修复

`f667718d` 的 CI Gate 38200411522 只有 architecture 审计根失败（其余 16 job 通过）。不提高 baseline、不禁用审计。依赖归属按实际文件收敛：

| 新增边 | 实际边界问题 | 本次归属 |
|---|---|---|
| agent-extraction → server/ai/tools/register-capability-tools | 领域执行重复承担进程级 registry 组合 | 删除重复注册，继续由 worker-boot 注册；单 case 显式模拟 boot |
| agent-extraction → server/ai/runner | 领域模块直接装配 server 执行器 | worker 启动处注入真实 runTask，纯 TaskRuntime 接口不含实现 |
| agent-extraction → server/ai/tools/pi-tools | 领域模块直接装配 server 工具桥 | 同一 worker 注入真实 buildPiDomainAgentTools，沿用既有 registry/logging |
| agent-extraction、agent-workspace、source-package → server/r2（三边） | 纯 blob 能力依赖具体 S3/R2 基础设施的类型位置 | 原有 put/get/delete 接口归回 kernel/BlobStore；server/R2Client 保留兼容类型别名 |
| agent-workspace → server/session | 材料工作区同时负责组装 session 草稿命令 | 工作区回传领域数据；extraction 组合调用原有 Ingestion.stageDocxAgentDraft，同一 tx 与 actor 不变 |
| agent-extraction → server/session | 必须经过已有 session 写入 owner | 保留公共 facade；旧 docx API → session/docx-ingestion 边随旧写入路径删除，无新增 owner |

删除重复注册后，实际超基线剩 ai +2、r2 +3、session +1；以上修复后审计精确为 capability→server 428 / server→capability-deep 0 / cross-capability-value 48。`JobDecl.load` 接收可选窄运行时依赖，在现有 worker 组合点传入；不改变旧 handler 工厂的第二参数语义。没有同义转发函数或藏依赖。

第二个 architecture 检查同时发现两个新 DomainTool 尚未列入 read/write 清单：现已补齐，并从 maintenance 宽读面排除 read_docx_source，仍只授予 docx_ingestion。deepening 审计通过：56 TaskSpecs / 48 DomainTools / 57 queues；其余四项 architecture 检查均通过。

## 当前 DOCX 请求前预算闸门

仅 DocxIngestionTask 声明 requiresRequestGuard；中央 runner 透传窄接口，Pi adapter 在每一轮完成 context 组装后、实际 provider streamSimple 之前执行准入。其他任务未声明/传入时保持原逻辑。不存在只在最终任务结束后计费的替代路径。

- DOCX 运行要求显式 `DOCX_AGENT_BUDGET_APPROVAL`，包含固定 provider/model、USD 价格版本、到期时间和不超过 1 USD 的单次额度。默认不配置即拒发请求；本次仅测试进程使用虚构授权数据，没有修改生产 env、读取真实 key 或访问计费账户。
- 仅价格卡 `xiaomi-overseas-usd/2026-10-08` 下直连 `https://api.xiaomimimo.com/v1` 的 `mimo-v2.5` / `mimo-v2.6-pro` 能匹配；实际解析结果必须一致，绝不改变全局 pin 或回退 provider。USD 授权只适用于已核对的海外美元账户，不能拿人民币账户、Token Plan 或 OpenCode 订阅估值冒充美元合同。
- 单次固定最多 16 次模型请求、24 次获准工具调用、240 秒；每次输出最多 4096 tokens（含思考），底层 maxRetries 强制 0，任务重试显式关闭。重复投递仍走已有 session 锁，不额外计成新的模型执行。
- assembled context 包含 system、用户、工具 schema、完整工具/模型历史；限制序列化后 128000 bytes，文本计费预留使用官方 1M 窗口对应目录 1048576 tokens 的整个上限，不以字数估 token。工具历史和协议开销均落在这个保守窗口预留内。收到用量后验证非负整数、输入确实有观测值、输入/输出不超上限，再按未缓存全价结算（缓存不享受折扣，更保守）。
- **图片 token 上界尚无已验证证据，因此当前读图拒绝；已组装 context 若含图片也拒绝发给 provider。** 拒绝发生在更新 seen_images 前，不能把未送达模型的图片记成已查看。这意味着当前完整视觉 DOCX 的真实 QA 仍被阻断，不是已验收的视觉产品链。
- 每次请求前在 source_document.provenance.docx_request_budget 持久预留，价格来源、模型/端点、窗口/输出上限、请求序号与金额可审计。原有 ai_task_runs/cost_ledger 写入 owner 未改。中断、结算失败或 unknown 用量保留全额预留，并拒绝该运行的后续请求；不会用零填未知，也不删除草稿。
- DOCX 预留通过 Postgres advisory lock 串行化。每次读取同一 UTC 周已有 task-run 成本，加 DOCX 已结算/未结算预留，超过 20 USD 或出现未知/活跃费用即拒绝。未发送请求有明确零-wire marker，避免把准入拒绝当作未知付费。旧 DOCX 无标记的 unknown 仍拒绝，不能臆断为免费。
- **20 USD 是 DOCX 对账本的准入检查，不是全站并发费用承诺**：其他任务没有接入此锁，外部账户消费也不在本地账本。首次真实 QA 须确认周剩余额度并隔离其他并发付费工作；本 PR 不引入全站计费框架。

公开依据：MiMo [价格](https://mimo.mi.com/docs/en-US/price/pay-as-you-go)、[模型窗口](https://mimo.mi.com/docs/zh-CN/quick-start/summary/model)、[输出包含思考的上限](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/other/deep-thinking)。每次请求预留 MiMo v2.5 为 $0.147948，v2.6-pro 为 $0.459695；这不是预估实际平均费用。价格/模型证据到期会拒绝，不能自动沿用旧价格。

同一既有 DB case 改为 `retains DOCX agent material and drafts through budget rejection and retry`：真实 runner/Pi agentLoop + 免费可控 provider 流。未知绑定与不足预算均 0 次 provider 调用；未知用量在第 8 次后终止并保留 147948 微美元预留；未知图片上界在第 8 次后终止且 seen_images 为空；文本恢复后保留两草稿，commit partial。整个 case 共 25 次本地受控 stream 调用，0 次 provider HTTP。

| 验收阶段 | 当前预算切片结果 |
|---|---|
| 完整提取 | 合成源材料 6 份摘要一致、草稿 2；不代表模型识别质量 |
| 图片引用 | 上界未知而拒绝；未谎报查看或归属成功 |
| 题型/选项 | 两草稿与 A/B 选项保留，无正则识别 |
| 草稿确认 | 失败保存、重试恢复、partial；原材料/草稿未删除 |
| 正式入库 | 两题因未决材料被明确拒绝，正式题 0、draft 2、ignored 0 |
| 可答题状态 | 无正式题，不宣称可答题 |

当前证据：`docs/planning/evidence/2026-10-12-yuk1404-docx-budget.json`。前面的 1 正式题 / 1 草稿来自预算闸门前的历史切片，不能代替本次结果。首次视觉真实 QA 尚需可审计的图片 token 上界或能拒绝超额的供应商账户额度证据；没有这样的证据就继续 fail closed，不先付费。Docling 不是这项费用证据的替代品。
