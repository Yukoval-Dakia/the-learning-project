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

## 免费验证与六阶段验收

只替换原 `import.db.test.ts` 的一个关键 case。外部 converter 返回合成材料、外部 agent 用可控工具调用模拟；实际执行材料存储、PDFium 页面渲染、工作区重建、registry 工具编译、Pi 图片结果、session/题块事务、canonical event、失败/重试、活跃重复投递和 import。
临时本地 PG + 内存 blob；未读取真实卷、未调用模型。此前暴露的 JSONB 键序比较及 Date 工具 schema 问题已修复后重跑同一 case，没有扩大测试矩阵。

| 阶段 | 本轮合成证据 | 真实学校试卷 |
|---|---|---|
| 完整提取 | 可控 agent 保存两题；六份材料字节摘要一致；不证明识别质量 | 未运行新 agent，不能沿用旧 d481 的 32 题结果 |
| 图片引用 | 本会话 image tool 有像素；越界句柄/题块拒绝；一张图明确未归属 | Q12/13、Q31/32 仍需同卷视觉核验 |
| 题型/选项 | 草稿 kind 与 A/B 保留；无正则识别 | #1658 题型/选项正式保全依赖未重复实现 |
| 草稿确认 | 中断后两草稿保留，重试不重复；空题/未决项可见 | 未验收 |
| 正式入库 | 一题正式入库；一草稿保留；ignored=0；session=partial | 未验收 |
| 可答题状态 | 正式题仍为 withheld / unverified_rules / container_only | 未验收，不能由导入成功推导 |

收尾证据：`docs/planning/evidence/2026-10-12-yuk1404-docx-agent.json` 与同名前缀日志归档。
本地执行范围是该单 case、typecheck、lint/ratchet、build、task census、test policy 和必要 API/Postman 生成。整套测试只交给推送后的 exact-head CI Gate。

## 下一次真实模型运行的最小依赖

- 一份获准使用的原卷，或等价的脱敏完整 source package；不能只给预切题文本。
- 核对实际 provider/model 绑定和视觉+工具能力。TaskSpec 默认 `xiaomi / mimo-v2.5`，运行配置可覆盖；不能把默认当作实跑事实。
- 当前单任务配置上限：48 次迭代、240 秒、`maxCost=0.5`、transientRetries=0。这是现有 runner 的成本保护配置，目录估价不等于供应商结算上限；执行前仍须确认实际计费与本次批准预算。
- 记录代码版本、输入/输出摘要、真实 task-run ID、实际模型、用量/费用依据，再分别对账上述六阶段。

旧「每周 20 USD」不作为本次调用授权。Linear 由父任务维护，本轮不重复扫描或写入。PR 保持 Draft；历史独立审查预算不重启，也不把旧审查当作覆盖本次迁移。
