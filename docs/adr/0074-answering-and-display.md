---
status: proposed
---

# ADR-0074 — 作答与展示：拍照/手写为主、受约束的生成式展示、作答位与判分单元的标准契约

**Status:** Proposed（设计方向，2026-10-11）；尚未实施。
**Decision source:** owner 2026-10-11 拍板 A1–A4、M1（决定记录 `/Volumes/YukovalSBak/yukoval-projects/tlp-status/decisions/2026-10-11-answering-display-phone.md`）；原始提议 15:23「最好是用手写上传/图片上传就行……agent 对于一些难搞的题目自己写展示方法，后端只获得判分拿哪些材料交给谁判（这个是要标准契约的），以及多少分」（讨论稿 `discussions/answering-and-display.md`）；15:34 笔写/断句补充；15:46 录入要快、进度清楚、Copilot 追问同视图。
**Tracking:** [YUK-1438](https://linear.app/yukoval-studios/issue/YUK-1438)（UI 线）、[YUK-1445](https://linear.app/yukoval-studios/issue/YUK-1445)（判分准入，契约底座）。
**Related:** ADR-0073（计分单元、冻结方法、一套判分、单元级服务门——本文的直接上游）、ADR-0072、ADR-0068（通用学科）、ADR-0069（D8 单一入库闸）、[YUK-1456](https://linear.app/yukoval-studios/issue/YUK-1456)（录入后 AI 复盘）、`docs/design/2026-10-07-ui-visual-direction.md`（R9 等）、真卷题型清点 `tlp-status/discussions/zj-g11-question-type-inventory.md`。

## 背景与问题

ADR-0073 钉死了判分侧：计分单元 + 入库标定的冻结方法 + 一套判分系统。剩下的两个面都还悬着：**作答怎么收**——今天的作答面按固定题型组件拼，遇到「难用的输入器」就是用户摩擦（owner 15:23 原话）；**题面怎么画**——owner 提议 Generative UI 式的「agent 自己写展示方法」，但自由生成 HTML/JS 不可审、可泄答案。代码现状（origin/main `ec4d42dad` 核实）：契约底座五层已建（`src/core/schema/assessment/`：structure 无题型枚举、response 九种槽位原语且 slot 无 points、scoring unit 唯一计分权威、execution 五比较器 + `model_executor` 须带 `admitted_slice_id`、revision 整体版本化）；证据面已有 image/audio/video/pdf/plaintext 与 `requires_group_evidence`（整页照）；上传与进度已有雏形（`/api/ingestion/pdf` 单 PDF→N 页图、`/api/ingestion/docx`、SSE `/api/ingestion/[id]/events`、`VisionTab` 的 upload→SSE→review→import）。缺的是：作答方式的默认值、展示 spec 的约束面、以及 owner 点名的「作答位 ↔ 判分单元」标准契约。本文钉这三个决定；不改任何现役判分语义。

## 决定

### D1 作答方式：拍照/手写为主（A1）

默认纸上作答拍照上传，或作答卷 PDF 往返（D4，GoodNotes 等 App 写完传回）；屏幕笔写为可选备选。点选只保留在「点选最省事」处：选择题，以及**录入 agent 能生成点选作答的地方一律优先点选**——断句是范例：在字与字之间点一下放断句（真卷 A–H 涂卡形态同构），点选结果是结构化位置集合，按该题入库的题级规则确定性判分（语文断句「每对一处 1 分、超 3 处 0 分」是题级数据，清点 §3-1 已证不能按科目推定）。打字对短文本作答可选。**不做硬输入控件**：无公式编辑器、无画图工具——`FormulaSlot`/`NumericSlot` 是契约原语，不承诺配编辑器 UI；`MatchingSlot` 注释已立先例「ID 对选择即可作答，不要求拖拽编辑器」（`response.ts:121`）。笔迹与照片**原样保存为证据**（`EvidenceKind` 现为 image/audio/video/pdf/plaintext，`materials.ts:72`；按此扩展 stroke 原始序列，位图只是派生渲染），整体交**准入 AI judge 按该单元冻结、标定过的方法**判（ADR-0073 D2）；`open_response` 槽的 `accepted_evidence` 与 unit 的 `evidence_slot_refs`/`requires_group_evidence` 就是承载面（`response.ts:141-147`、`scoring.ts:118-124`）。**连线题＝手写上传、AI 整体判**（owner A3 原话：连线只能手写上传），不做画线的确定性判分。capture 读不准时**只追问一句**、不重复提交（追问形态见 D5）。

### D2 展示 spec：录入时产出的声明式积木拼装（A2）

录入 agent 为每道题产出**声明式展示 spec**，从设计系统积木中拼：passage 左栏（R9：文章常驻左、题在右、**不得上下堆叠**）、figure（可缩放，`SharedMaterialKind` 已含 figure/passage/table/audio，`materials.ts:20-28`）、表格、公式块、选项列表、行内空位、小问列表、排序、音频、代码块、**断句点选块**（tap-between-characters）、**书写画布**（writing canvas）。积木渲染器落在 `src/ui-next/` 基座（`primitives/`/`tokens.css`，scoped 纪律见其 AGENTS.md）。极少数积木拼不出的题走**沙箱自定义渲染**出口，四条硬约束：无网络、无学习者数据、随题目 revision 版本化、录入时预览检查（材料齐全、不泄露答案、可读）。**spec 永不含答案 key**——私有 rubric/sol 资产已被 `isPublicSharedMaterial` 挡在公开投影外（`materials.ts:63-67`），同一纪律覆盖展示 spec。

### D3 标准契约：作答位 ↔ 判分单元绑定，后端只认证据 + 方法 + 分

展示 spec 里的**每个作答位绑定一个 scoring_unit_id**（经 revision 的 ResponseSpec 槽位）。对每个单元，后端只认三件事：**收哪些证据**（option_ids / 空文本 / 位置集合 / 照片或笔迹区域）、**哪个冻结判分方法**（ADR-0073 D2 的判据 + 执行器 + 版本）、**多少分**。这正是既有形状：`ScoringUnit` 的 `slot_refs`/`evidence_slot_refs`/`criterion`/`points`（`scoring.ts:115-126`），slot 上无 points 的纪律（`response.ts:10-12`）。**录入时校验绑定**：`validateScoringBasis` 已在发布 barrier 纯校验 unit→slot 可解析、判据↔槽位种类相容（`criterion_slot_kind_mismatch`）、证据槽必须 open_response（`scoring.ts:187-204, 206-223, 230+`）；本 ADR 把展示 spec 纳入同一 barrier——spec 渲染的作答位必须落在 revision 槽位上且被某 unit 消费，**错配 ⇒ 该题不准入**（与 ADR-0073 D5「未标定不出」同一出口）。**展示永不影响判分**：换版式、换 renderer、改交互都不动 judgment；判分只读证据与冻结方法。

### D3a 配对与断句的作答契约（owner 16:28 更正：配对题＝左右两列配对，点选作答、确定性判）

- **配对**：作答 `{kind:'matching', pairs:[{left_id,right_id}]}`（稳定 id，不认文字/位置）；判据 `matching_pairs_key`，私有、随 revision 冻结、DTO 剥离；默认一题一个计分单元，卷面印每对分值时录入拆为每对一单元；基数（一对一 / 允许多对一 / 含干扰项）逐题写在作答位 spec，界面按其约束；部分分：全对满分、卷面有印规则按印规则、无印规则记录对数且结果为 partial、分数未知（与多选子集同政策，不造分）。15:51 A3「连线手写上传 AI 判」作废；真正需要画图的题仍走作答卷/手写。
- **断句**：作答 `{kind:'sentence_breaks', positions:number[]}`（对冻结 revision 文本的字间位置索引）；新增确定性判据「位置集合键」（接受的断点集合 + 题级规则，如「每对一处 1 分、超 3 处 0 分」），属 scoring schema 扩展，标定探针含认对参考集合、判错多断与错位。

### D4 手写主路径：排版良好的作答卷 PDF ↔ GoodNotes 等笔记 App 往返（owner 16:14，取代 A4 网页笔写为主路径）

owner 在 iPad 实测网页笔写原型后：「不行，书写质量差。我在想是否该这样：输出排版良好的pdf，我在goodnote做完再把pdf传回来。」因此手写作答的主路径改为**作答卷往返**：
- **导出**：一组题（今日练习/一张卷/复盘题）导出为排版良好的作答卷 PDF，题面按 D2 展示 spec 的印刷版式渲染（含公式、图、文章；文章类题在横版页上文章左、题右），每个计分单元有**预留作答区**；每页印**作答卷身份码**（发放 issuance id + 页码，二维码 + 人可读短码）与作答区定位标记。导出即一次 issuance，选项顺序等随 issuance 冻结（ADR-0073、`dto.ts` option_order），沿用 YUK-1427「打印纸卡、纸上作答、回收时保住同一任务身份」。
- **回收**：学习者在 GoodNotes 等 App 作答后导出 PDF（或纸质打印后拍照）上传；系统按身份码与定位标记把每个作答区确定性对回计分单元（不靠猜题），再由录入同一套 capture 逐区读出作答（圈选的选项、空内文字、过程、断句斜线、连线笔迹、红笔订正按偏好）交 ADR-0073 同一判分。找不到身份码/定位标记时退回普通照片录入路径并如实标注。
- **网页笔写降为可选**：Pointer Events 画布保留为轻量备选（短答、临时草稿），不作手写主路径；PaperKit 仍只记为未来原生/套壳 App 选项。点选（选择题、agent 生成的断句点选块）照常在网页完成。

### D5 录入视图与进度（owner 15:46）

录入要快，进度**typed 且诚实**：阶段、页数、已发现题数、失败项带原因；题目渐进出现（现雏形：SSE `/api/ingestion/[id]/events` + `derivePhaseFromEvents`，`manifest.ts:139-149`、`ingestion-phase.ts:69-80`；`VisionTab` 已有逐块预览与页 bbox overlay，`src/ui/components/VisionTab.tsx:3-17`）。capture 的澄清是 **Copilot 在同一视图里问的 typed item**（D1 的「只追问一句」落点），回答即补 capture，不重交整卷。录入完成后提供 **opt-in 的 AI 整卷复盘**（[YUK-1456](https://linear.app/yukoval-studios/issue/YUK-1456)）。

### D6 手机（M1）

浏览器打开 +「添加到主屏幕」：web manifest 与图标、standalone 显示、上传直接调相机（`capture` / `<input accept="image/*">`）、手机布局。上传复用现有 `/api/ingestion/pdf|docx` 与资产上传（`manifest.ts:104-125`、`src/ui/lib/assets.ts:42-69`）。私有远程访问归迁移/运维线，不在本 ADR 代码范围。

### D7 归属与交付

- **UI（仅 Opus，YUK-1438）**：积木渲染器（含新设计语言：吉祥物、形变动效、层级）、作答卷的印刷版式渲染、录入视图、PWA、可选网页笔写画布。
- **功能线（YUK-1445 侧）**：录入时 spec 产出（agent 面）、绑定校验进发布 barrier、作答卷导出（issuance 绑定、身份码、定位标记、预留作答区）与回收对回（按身份码/标记确定性映射到计分单元，找不到则退回照片录入并标注）、点选与笔迹/照片捕获、追问 item。
- **迁移线**：job 的 DBOS/pg-boss 接线、Start 路由、私有远程访问。
- 交付按 AGENTS.md 阶段；验收在**真机**上做，有 iPad + Apple Pencil 的环境必测笔写与自动提示。

## 硬边界（后果）

1. **默认拍照/手写**；不得为「好判」给学习者加硬输入控件（无公式编辑器、无画图工具；验收项）。
2. 展示 spec **声明式且永不含 key**；沙箱出口必须同时满足四条约束（无网络、无学习者数据、随 revision 版本化、录入预览检查）才准用。
3. spec 与槽位/单元**绑定错配 ⇒ 不准入**；展示改动永不改判分（零第二判分语义，同 ADR-0073 边界 3）。
4. 点选产出的位置集合只按**题级冻结规则**确定性判；连线不走确定性画线判分。
5. capture 不确定**只追问一句**；不重复提交、不静默猜测。
6. 判分复用 ADR-0073 冻结方法与 D5 服务门；本文不新增判分逻辑、不改五层契约既有纪律。

## 分阶段交付

1. **第一刀（TEST）**：选择题点选 + 断句点选积木 + 配对题点选（`matching_pairs_key`）确定性判 + 拍照上传走 `open_response` 证据 → 冻结方法判；作答卷 PDF 导出与回收对回；录入 spec 与绑定校验进 barrier；验收＝iPad 真机作答卷往返（GoodNotes 导出 PDF 传回 → 每个作答区对回正确单元并出分）与点选题实测。
2. **第二刀**：沙箱出口、PWA、Copilot 同视图追问与 AI 复盘接线；可选网页笔写画布（平板书写模式与自动提示在此刀验收）；随 YUK-1388 功能波次替换 `/record` 现有录入面。

## 被拒绝的备选

- **自由生成 HTML/JS 展示**（owner 提议的原始全量形态）：不可审、可泄答案、可触网——被「积木拼装 + 极窄沙箱出口」取代（A2）。
- **只做固定 per-type 组件**：与 structure「无题型枚举」纪律冲突（`structure.ts:9-11`），复合题/新材料组合拼不出，每加一型改一次前端。
- **per-type 输入控件**（公式编辑器、画图工具）：正是 owner 15:23 否决的「难用的输入器」摩擦源。
- **连线画线的确定性判分**：把「画的线」读成配对是启发式解析，与 ADR-0073 边界 1「零文本解析键」同源的错误；owner 拍板手写上传交 AI 判（A3）。

## 未决问题

- stroke 证据的最小契约（采样率、坐标系、整页 vs 分区域）——随第一刀实测定。
- 断句的字间点选与真卷 A–H 涂卡是否统一为一个位置集合槽原语（倾向统一，实施时定）。
- 沙箱 renderer 的隔离机制（iframe sandbox / Worker）与 CSP 收口——UI 线与迁移线共定。
- 手机上带文章题的形态（R9 已留未决，归做题页检查点裁决）。
- 录入视图与现役 `VisionTab`/`/record` 的替换波次（随 YUK-1388 功能区排期）。
