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

## 当前 DOCX 请求前预算与图片准入

仅 DocxIngestionTask 声明 requiresRequestGuard；中央 runner 透传窄接口，Pi adapter 在每轮组装 context 后、实际 streamSimple 前执行准入。其他任务保持原逻辑。本轮只修正指定模型的图片上界与价格适用检查，不改全局预算框架、生产 provider pin 或模型能力目录。

- 显式配置 `DOCX_AGENT_BUDGET_APPROVAL` 的字段为 `priceRef`、`provider`、`model`、`currency`、`accountPricing`、`maxRunUsd`、`expiresAt`。新增 `accountPricing: overseas-pay-as-you-go-usd` 是操作者对账户适用海外 USD 档的确认，不能由共享 API 主机推断；未知/缺失/其他档拒绝。只有虚构测试配置，生产授权仍未设置。实际海外 USD 账户必须先由父任务核对。
- 价格卡 `xiaomi-overseas-usd/2026-10-08` 仅匹配直连 `https://api.xiaomimimo.com/v1` + `openai-completions` 的既有两个模型；**本轮只对 `xiaomi/mimo-v2.6-pro` 放行图片**。v2.5 仍拒绝图片；Token Plan、OpenCode 和其他模型不扩大支持。实际解析模型/端点/窗口必须吻合授权。
- [官方图片契约](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/multimodal-understanding/image-understanding)（2026-09-22）明确全部图片与文字 tokens 受模型上下文约束，按输入/缓存输入/输出 token 计费；每图估算代码只供参考。本实现不采用每图 8192 为硬界。
- [官方配置](https://mimo.mi.com/docs/en-US/tokenplan/integration/openclaw)的按量配置给出 v2.6-pro contextWindow=1048576；[模型页](https://mimo.mi.com/models/en-US/mimo-v2.6-pro)列出图片输入与 1M context。因此整模型窗口预留同时覆盖文本、图片、工具 schema/历史和协议开销。文本/工具序列化上限仍为 128000 bytes，计算时排除 image base64，只留图片类型元数据；`contextBytes` 是这个文本口径，不是 HTTP 请求大小。
- [海外价格](https://mimo.mi.com/docs/en-US/price/pay-as-you-go)（2026-10-08）：输入 cache miss $0.435/M，输出 $0.87/M；缓存按输入全价保守计算。每请求 `(1048576×0.435 + 4096×0.87)/1000000 = $0.45969408`，向上取整到微美元为 **$0.459695**。接受请求的整个 context 上限已经包括所有图片，不需要再猜图片 token 数。
- [API 输出契约](https://mimo.mi.com/docs/en-US/api/chat/openai-api)的 `max_completion_tokens` 包括可见输出和 reasoning。SDK 序列化后、transport 前的 DOCX 回调强制 `max_completion_tokens=4096` 并移除旧 `max_tokens`；拒绝非 function 原生工具（含额外计费 web search）、web_search_options、多输出 choice 或模型漂移。底层 maxRetries=0；任务瞬时重试关闭。仅现有 DOCX 工具清单获准。
- 每 run 最多 16 模型请求、24 工具、240 秒、授权额度≤1 USD。每次有效 usage 后释放多余预留，下一次要求“本 run 已结算费用 + 新全额预留≤额度”。两次满额为 $0.919390，第三次超 1 USD；实际用量低可继续到 16 次。16 次满额约 $7.35512，因此 1 USD 不保证完整试卷能够收敛。手动 retry 是新 run，不是同一 1 USD 的续期。
- 请求前持久写入 source provenance，包括账户价格声明、窗口、费用和模型来源；未知用量/中断保留全额 reserved/unknown，并终止该 run 后续请求。新 run 不删除旧预留，旧预留继续占所属 UTC 周的额度；原材料和草稿保留。已有 receipt 缺少新账户字段仍可读取，但新请求必须有明确声明。
- **周账不完整的阻塞保持不变**：当前只读取本周 ai_task_runs.cost_usd + DOCX 持久预留并按 run 去重；现代 runner 的配对 cost_ledger 不重复计。没有对应 run 的旧 cost_ledger、独立 provider_attempt 未纳入；run 按 started_at 分周，非 ledger occurred_at。未知 run 拒绝准入。20 USD 检查不是账户全周总额保证，也不锁其他任务/外部消费。首次 QA 必须由父任务对齐历史费用和剩额，并隔离其他付费工作；本轮不扩展计费框架。

### 本轮受控验收

仍只修改 `retains DOCX agent material and drafts through budget rejection and retry` 一个既有 DB case。真实 runner/Pi agentLoop、PG、PDFium、材料/草稿 owner；provider 流受控，其中两次带图请求走真实 Pi OpenAI SDK 的序列化与重试层，最终 fetch 替换成内存 SSE，真实 HTTP=0。

**测试限定**：生产应用目录尚未确认直连 xiaomi/mimo-v2.6-pro 的 toolCalling/vision 能力，真实任务会先被该门拒绝。case 只在测试进程注入明确标记的 provider 能力元数据，并在结束时恢复；没有改生产目录。Pi 原生 catalog 已有该模型的 text/image、openai-completions 和 1048576 窗口，但这不能替代应用准入。此结果只证明预算/线材契约，不证明模型质量或生产可运行。

未知账户档、未知绑定和不足预算均 0 次 stream。未知用量在第 8 次后终止，459695 微美元持久保留。重试先保存/修订两草稿，再由现有读图工具取像素；两次真实 SDK 序列化后的请求体含 base64 图片、max_completion_tokens=4096、无 native search；两次满额 usage 后，下一次请求因 1 USD 不足被拒绝。该 run 共 10 次请求，低用量历史结算后合计 922942 微美元。再次恢复 9 次受控流后 commit partial。全部共 27 次受控 stream、2 次内存 fetch、0 次外部 HTTP。

| 验收阶段 | 当前结果 |
|---|---|
| 完整提取 | 合成材料 6 份哈希一致、草稿 2；非原卷识别质量 |
| 图片引用 | 1 页图经工具进入真实 SDK 请求体；未确认真实题图语义归属 |
| 题型/选项 | 两草稿与 A/B 选项保留，无正则识别 |
| 草稿确认 | 未知用量/超预算后保留并恢复；最终 partial |
| 正式入库 | 未决材料明确拒绝，正式 0、draft 2、ignored 0 |
| 可答题状态 | 无正式题，不声称可答题 |

本轮证据见 `evidence/2026-10-12-yuk1404-docx-vision-budget.json`。旧 `*docx-budget.json` 是 0ff5cbf 的拒图历史切片；更早正式1的结果也不能替代当前验收。

首次真实 QA 仍 blocked：父任务需处理直连模型应用准入、确认海外 USD 账户/价格及周历史费用与剩额、明确本次 run 金额/时窗和原卷内容传输授权，并只读核对实际路由绑定。未读生产 key/account/pin、未付费、未增加模型适配、未部署或合并；本切片完成后暂停新增代码。
