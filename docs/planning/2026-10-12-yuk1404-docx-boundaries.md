# 学校 DOCX 题号与图片保全（YUK-1404）

第一天能用；服务录入后题目完整性契约。基线 `d3885e83`，独立分支
`fix/yuk-1404-docx-question-boundaries`。本切片不改 UI、判分、付费调用或 #1658 的写入逻辑。

## 根因与证据边界

Mac 原卷历史运行：2026-10-11 08:52:32Z，源码 `97b3a91c`，32 题 → 10 draft。
块号为 1/6/8/10/12/13/17/伪1/伪2/31；大部分未独立题文仍在前块中。
4 个内嵌媒体转换保留，但题块只有 2 个不同图片引用。正式题 0，worker 未运行、AI 调用 0；
这不证明后续入库失败。原 Pandoc Markdown 未封存，不能逐题断言变化发生在转换器还是 parser。
原卷 137 段、0 表格、0 OMML、4 drawing；Q27/28 原 XML 已串接。
Q30 的 A 来自 Word upperLetter 编号。Q31/32 两图共锚且 XML 与 PDF 视觉次序相反，
文本切分不能确定其归属。这些是父任务转交的脱敏结构事实，本环境未读取真实卷。

当前源码已确认：

- 题号正则要求半角句点后空白，漏掉无空格、全角句点和加粗题号。
- GFM 将 Word upperLetter 选项写为数字列表，造成伪题号；真实 Pandoc 合成输入已复现。
- 题号/选项分支先返回，漏同一行图；普通图行只取第一图并丢同段文字。
- session 原先仅钉住题块引用的媒体，`source_document.body_md=null`，缺口仍报告 extracted。

## 最小修复

在既有 converter 增加仅处理 UpperAlpha 的 Pandoc Lua filter，保留字母编号；
既有 segmenter 支持上述题号形式与同行选项，保留同段文字和所有图引用。
倒序/重复数字保留为正文并警告，避免静默制造伪题；缺号、空题干同样警告。
空题干旁多张不同图不依据 XML 次序强配，媒体保留在来源上，明确要求视觉复核。

既有 session writer 保存完整转换 Markdown 与 `provenance.docx_media` 的路径→asset ID 映射，
全部媒体并入来源/session；不能归题或未能保存的图明确警告。
检测到缺口时走已有 partial → reviewed 守卫，不自动录入。
外部资源省略通知本身仍保持原行为，不独自使 session 变 partial。

## 分阶段验收

本地使用 7 题非敏感合成 DOCX，真实 Pandoc 3.1.11.1、LibreOfficeDev 26.8、PDFium，
独立临时 PostgreSQL；仅 R2 用内存替身，无 worker/provider，无真实 R2。

| 阶段 | 已执行结果 | 限度 |
| --- | --- | --- |
| 完整提取 | 7/7，题号 1–7；同输入旧链得到 1/5/6/7/伪1/伪2/伪3/伪4 | 不代表原卷 32/32 |
| 图片引用 | 合成 Q4/5/6 各 1 引用，Q1 不再拿到 Q4 图；全文与媒体映射保存 | 原卷 31/32 归属未验；不声明公开题图可用 |
| 题型/选项 | 4 个有选项题的 structured.options 保留，Word 自动 A–D 保留 | 文本提取未猜测题型；正式 choices_md 仍 null，依赖 #1658 |
| 草稿确认 | 7 draft；以既有 markReviewed 明确确认 | 验收脚本显式指定合成知识点和题型，无 AI 自动确认 |
| 正式入库 | 未启 worker 时 0；明确确认后手动 import 7/7 | 不是自动录入或真实卷验收 |
| 可答题状态 | 0/7：withheld / unverified_rules / container_only | 保持现有准入门；归现有判分准入工作 |

另仅新增 1 条 DB 边界回归：缺号/空题干/同锚多图仍保留全文与四图映射，
所有草稿可读、警告进入 extraction receipt，partial 不能直接 import。
无小 helper 测试，无全量本机测试；新增测试行数低于产品行数。

[来源摘要及逐阶段结果](evidence/2026-10-12-yuk1404-docx-synthetic.json)；
[非敏感输入、输出、验收脚本与日志](evidence/2026-10-12-yuk1404-docx-synthetic.tar.gz)。
摘要钉住四个产品文件 SHA256，原卷验收 false、provider calls 0。

## 剩余依赖与下一步

1. Mac 在候选上免费重跑真实卷转换/上传，并封存 Pandoc Markdown；逐题对账至 32，
   不能以本合成输入替代。Q27/28 串接和图片内题号仍可能需要人工/视觉复核。
2. Q31/32 的 PDF 视觉归属待确认；本补丁保留材料并标 partial，不凭锚点顺序补造题。
3. #1658 保持 Draft，待其原有验收；本分支不复制其题型/choices 写入实现。
4. 正式题进入可答题仍需既有准入验收；未新增付费预算，也不伪造 admitted。

不 merge、不部署、不触及 #1700 或父任务合并分支。所有后续均已在 YUK-1404 范围内，
无需重复建票；本票保持 In Progress。

## 交付验证

本地 typecheck、lint（既有 172 warnings）、build、test-policy（1 checked / 0 errors）通过；
唯一新增 DB 回归通过，gen:postman 重生成无差异；独立初审 NONE。
静态检查曾抓到测试调用 Tx 参数不匹配，已按真实事务边界修正；
初次 test-policy 使用 HEAD 别名被拒，改用固定 commit SHA；这些不是产品验收通过记录。
正式 PR 保持 Draft，CI 状态以推送 head 为准。

已正常纳入父任务最新 main `8fb160ed`（本分支合成 `c94f4152`），四个产品文件和唯一新增
回归与独立审查版本完全相同。合成提交再次通过 typecheck/build、同一 DB 回归与同一
7题实际转换→确认→正式入库路径；未扩测试矩阵。证据 JSON 的格式错误已修正。

Draft PR [#1703](https://github.com/Yukoval-Dakia/the-learning-project/pull/1703) 已创建。
临时本地 PG 已停止删除，原有 Postgres 容器未动。Linear 写入被自动审批拒绝，
理由为实现授权未明确覆盖外部 tracker 更新；未宣称同步成功，待父任务授权或代为更新。
