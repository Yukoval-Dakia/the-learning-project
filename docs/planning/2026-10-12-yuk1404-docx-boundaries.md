# 学校 DOCX 题号与图片保全（YUK-1404）

第一天能用；服务录入后题目完整性契约。基线 `d3885e83`，独立分支
`fix/yuk-1404-docx-question-boundaries`。本切片不改 UI、判分、付费调用或 #1658 的写入逻辑。

## 根因与证据边界

Mac 原卷历史运行：2026-10-11 08:52:32Z，源码 `97b3a91c`，32 题 → 10 draft。
块号为 1/6/8/10/12/13/17/伪1/伪2/31；大部分未独立题文仍在前块中。
4 个内嵌媒体转换保留，但题块只有 2 个不同图片引用。正式题 0，worker 未运行、AI 调用 0；
这不证明后续入库失败。原 Pandoc Markdown 当时未封存；本轮父任务已重跑旧链，摘要与历史一致并精确复现 10 块。
原卷 137 段、0 表格、0 OMML、4 drawing；Q27/28 原 XML 已串接。
Q30 的 A 来自 Word upperLetter 编号。Q31/32 两图共锚且 XML 与 PDF 视觉次序相反，
文本切分不能确定其归属。这些是父任务转交的脱敏结构事实，本环境未读取真实卷。

本 PR 首轮修复前的源码已确认：

- 题号正则要求半角句点后空白，漏掉无空格、全角句点和加粗题号。
- GFM 将 Word upperLetter 选项写为数字列表，造成伪题号；真实 Pandoc 合成输入已复现。
- 题号/选项分支先返回，漏同一行图；普通图行只取第一图并丢同段文字。
- session 原先仅钉住题块引用的媒体，`source_document.body_md=null`，缺口仍报告 extracted。

## 最小修复

在既有 converter 增加仅处理 UpperAlpha 的 Pandoc Lua filter，保留字母编号；
既有 segmenter 支持上述题号形式与同行选项，保留同段文字和所有图引用。
倒序/重复数字保留为正文并警告，避免静默制造伪题；缺号、空题干同样警告。
空题干旁多张不同图不依据 XML 次序强配，媒体保留在来源上，明确要求视觉复核。
所有按 DOCX 文本锚点暂存的图引用都明确警告并进入 partial：转换后的 Markdown
没有足以证明浮动图视觉归属的信息，不把暂存的 block 关联当已核验 FigureRef。

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
| 图片引用 | 合成 Q4/5/6 各 1 引用，Q1 不再拿到 Q4 图；全文与媒体映射保存 | 当前均以文本锚点待复核警告进入 partial；不声明公开题图可用 |
| 题型/选项 | 4 个有选项题的 structured.options 保留，Word 自动 A–D 保留 | 文本提取未猜测题型；正式 choices_md 仍 null，依赖 #1658 |
| 草稿确认 | 7 draft；以既有 markReviewed 明确确认 | 验收脚本显式指定合成知识点和题型，无 AI 自动确认 |
| 正式入库 | 未启 worker 时 0；明确确认后手动 import 7/7 | 不是自动录入或真实卷验收 |
| 可答题状态 | 0/7：withheld / unverified_rules / container_only | 保持现有准入门；归现有判分准入工作 |

另仅新增 1 条 DB 边界回归：缺号/空题干/同锚多图仍保留全文与四图映射，
所有草稿可读、警告进入 extraction receipt，partial 不能直接 import。
同一 case 已补年份题干、小数与倒序计数断言，没有增加案例或测试矩阵。
无小 helper 测试，无全量本机测试；新增测试行数低于产品行数。

[来源摘要及逐阶段结果](evidence/2026-10-12-yuk1404-docx-synthetic.json)；
[非敏感输入、输出、验收脚本与日志](evidence/2026-10-12-yuk1404-docx-synthetic.tar.gz)。
摘要钉住四个产品文件 SHA256，原卷验收 false、provider calls 0。

## 剩余依赖与下一步

1. Mac 已在固定 `057e9efc` 免费跑通转换并得到 27 块，见下节；年份漏切修正后仍需在新 head
   对账。即使块数达到 32，也不表示题面完整，Q27/28 原 XML 串接须单独保留为源问题。
2. Q12/13 浮动图及 Q31/32 的 PDF 视觉归属待确认；本补丁保留材料并标 partial，
   不凭锚点顺序补造题。Q12 有图、Q13 无图不是归属正确的验收证据。
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

## 原卷固定提交复跑与年份漏切修正

父任务在 Mac 免费离线运行固定 `057e9efc`：32 题提取为 27 块；伪数字题已消失，
Q30 的 ABCD 完整。Q4/9/19/20/27 的紧贴题号年份被 `(?!\d)` 排除，分别并入此前块。
同时旧转换命令 + 旧 parser 精确复现 10 块，转换 Markdown 摘要匹配历史。
这定位了剩余五个漏切到 segmenter，不再把历史 10 块当作当前结果。

最小修正允许 `N.YYYY年`，仍保留 `2.5米` 的小数保护和倒序章节计数的正文保全/警告。
这是针对已证实的年份格式修复，不声称任意数字开头题干都已消歧。
同一真实 DB 边界 case 在旧实现得到 `[1,4]` 而失败；修正后得到 `[1,2,4]`，
年份题及两组 ABCD 分别保留，小数和倒序计数不制造伪题，完整来源/四图和 partial 守卫仍成立。

父任务原卷四图字节保全，但 Q31/32 的独立块题干为空，两图未归题且有警告；
Q12 暂持另一张图、Q13 无图，既有视觉证据指向 Q13。当前增加文本锚点图片归属警告，
使这种暂存关联明确需要复核，不做缺乏视觉证据的重分配。Q27/28 源串接问题独立保留。

唯一验证复审结论 NONE（只读这次两文件 delta，无测试/provider）；不再启动第三审。
本环境仍未取得原卷；新 head 的原卷计数、Q27/28 题面与图片视觉归属待 Mac 重验。
本次同一 7 题实际转换→临时 PG→明确复核→手动导入再次通过；三处图片关联警告使初始状态为 partial，
正式题仍 7、可答题仍 0。没有复跑 #1658 集成矩阵或扩展准入实现。
本轮 typecheck、lint（172 既有 warnings）、build、test-policy（1 checked / 0 errors）通过。
临时 PostgreSQL 已删除，原有数据库未触及；Linear 按父任务要求不重试、不换通道。

[本次脱敏复现、执行日志与来源版本证据](evidence/2026-10-12-yuk1404-docx-years.tar.gz)。
旧 synthetic 证据包保持为旧版本结果，不能当作新 head 的无警告验收。
