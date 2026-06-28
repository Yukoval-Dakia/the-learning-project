# 录入出口叙事 + rescue 失败态 + phase0 退化态 — 功能 handoff（给 claude design）

- **date**: 2026-06-28
- **status**: functional handoff（零风格规定）—— 视觉稿由 claude design (claude.ai/design) 出，回来 slice-by-slice 实现
- **epic**: 形态轴 YUK-354 · 缺口 A8（gate doc `docs/design/2026-06-15-rethink-implementation-gate.md` §2.8 第 8 条）
- **数据状态**: 出口叙事所需的产出计数已在 import 响应里（无需后端）；rescue 富策略与 figure 回显有后端缺口（见末尾「基础设施缺口」）

> 这是**功能** handoff：只描述录入完成 / 失败 / 退化时该让 owner**理解什么、能做什么**，**不规定任何视觉风格/布局/配色/组件选型**——那是 claude design 的活。实现回来后按项目 design tokens/primitives（loom 系统）落地。

---

## owner 想解决的问题

录入是这个工具的**主要入口**（上传为主、生成降级）。但录入「做完之后」的体验是断的：
- 成功后**硬跳走**到 `/mistakes`（死链已闭，#508 上线了该 route），但跳走那一刻**什么都没交代**——这次录入到底产出了什么、进了哪、接下来能干嘛，全靠 owner 自己回去翻。录入是「把外部材料变成系统里能练的东西」的关键转化点，转化完成却没有叙事确认。
- 抽取**失败 / 退化**时只有干巴巴的一行报错，没有「下一步怎么办」的逃生口。

owner 想把录入出口从「提交完跳走」变成**有交代的着陆**：产出什么、可信度如何、哪里需要人工补救、下一步去哪。三件事：①成功出口叙事 ②rescue 失败态 ③phase0 边缘退化态。

---

## 现状反模式（锚真代码）

### ① 成功后硬 navigate，零叙事
- 手动错题表单：`src/capabilities/ingestion/ui/RecordPage.tsx:130` —— `onSuccess: () => navigate('/mistakes')`，提交成功直接跳，无任何产出回执。
- 拍单题 / 拍试卷 / PDF / DOCX 批量导入：`src/ui/components/VisionTab.tsx:458-461` —— `onSuccess` 里 `invalidateQueries(['mistakes'])` + `routing.navigate('/mistakes')`，同样硬跳。
- 后端**已经返回了产出清单**但前端丢弃了：import 响应 `src/capabilities/ingestion/api/import.ts:552-556` 返回 `{ question_ids, mistake_ids, record_ids }`（每个数组一项 = 一道导入的题）；手动表单 `POST /api/mistakes` 返回 `{ question_id, mistake_id, record_id }`（`RecordPage.tsx:111`）。**这些计数 / id 现在被前端无视**——叙事出口可直接用它们，无需新后端。

### ② rescue 失败态：只有全局一行报错
- review 页每个非 `structured` 质量的块给 Tier 2 / Tier 3 救援按钮（`VisionTab.tsx:856-877`），调 `POST /api/ingestion/[id]/rescue`（`rescueMutation`，`VisionTab.tsx:465-481`）。
- 失败时**唯一**反馈是顶部一行全局文字：`VisionTab.tsx:714-716` —— `{rescueMutation.isError && <p>救援失败：{formatError(...)}</p>}`。不锚定是哪个块失败、不提供重试、不区分错误类型。
- 后端有一类**结构性「未实现」**会以 501 返回但前端只当普通报错：`src/capabilities/ingestion/server/rescue.ts:45-51` —— 仅 `strategy='extract'` 实现，`restructure_cloze` / `restructure_compound` 抛 `not_implemented`（501）。当前 UI 没有暴露这两个策略入口，但若设计想要「重抽 vs 重组」的富救援，失败叙事要能区分「这条没救出来，重试」与「这种救援方式还没做」。

### ③ phase0 边缘退化态（已编目，现处理粗糙）

- **figure crop 无回显**：抽取会把题图（diagram）按 bbox 裁出、PNG 上传 R2（`src/capabilities/ingestion/server/crop.ts:30-65`），`/blocks` route 也把 `figures` 字段返回（`src/capabilities/ingestion/api/blocks.ts:59`）。**但 review UI 完全不显示它们**：`VisionTab.tsx` 的 `BlockRow` 类型（89-114 行）根本没有 `figures` 字段，`BlockImageStrip`（1033-1061 行）只渲染整页 `image_refs` / `source_asset_ids` 的缩略图 + bbox 叠框。owner 看不到「系统从这道题里抠出了哪几张图、挂给了谁」——抠了图等于没抠。
- **PDF 超时不真取消**：PDF 在路由里**同步**渲染（`src/capabilities/ingestion/api/pdf.ts:55-68`，不走 worker），有 30s 超时 + 15 页上限（`pdf.ts:17-18` 注释，由 `pdf-render.ts` 强制）。前端 `expanding` 阶段（`VisionTab.tsx:639-676`）只显示「展开 PDF…」文字 + 进度，**没有任何取消按钮**——owner 上传了一个慢/大 PDF 只能干等到超时报错，无法主动放弃。「不真取消」= 即便点了别处，那次同步渲染仍在后端跑完。
- **DOCX 绕过结构**：DOCX 走「文本直抽线」(`ingestionLine='text'`，`VisionTab.tsx:314-327`)，pandoc 同步切题、不入 OCR/VLM 抽取、**没有结构化树**。视觉线的块有只读「OCR structured 树」可展开核对（`VisionTab.tsx:909-914`，依赖 `primary.structured`），文本线的块**没有这层**——它直接产出可编辑块，review 时 owner 无从核对切题是否切对。完成态用 `TextLineCompletePanel`（`VisionTab.tsx:1164`）显示「文本直抽完成 · N 块」。
- **空块**：抽取完成但产出 0 块时，唯一反馈是 `VisionTab.tsx:687-689` 一行裸文字「抽取完成但没有产出任何块；可能是 OCR 没有识别到题目。」——没有「为什么没识别到 / 换张图重试 / 手动录入兜底」的出口。

---

## 面板应呈现什么（功能层，非视觉）

### ① 成功出口叙事（着陆而非跳走）

录入成功后，不是立即跳走，而是一个**有交代的着陆**，让 owner 一眼明白「这次录入发生了什么 + 下一步」。功能要素：

1. **产出回执**：这次录入产出了**几道题**（用 import 响应的 `question_ids.length` / 手动表单的单条），进了哪些**通道**：
   - 题库（canonical question）—— 每道导入的失败块都产生一道 question + 一条 attempt 事件（`import.ts:4-10` 头注）。
   - 知识点 —— 每道题挂了 owner 选的 `knowledge_ids`（手动表单 / 块编辑器都强制至少 1 个）；冷启链会为不存在的知识点建节点（A8 关联 §2.8a「录入→图谱」，本 handoff 不含图谱侧）。
   - 错题本 —— 失败块进 `/mistakes`（错题是标记不是独立通道，per D11）。
2. **下一步可供性**（行为驱动，非死跳）：从着陆点能选择去**哪**——看错题本、继续录下一批、去练刚录的、或回工作台。现状是单一硬跳 `/mistakes`，应变成**多出口**（owner 拍具体去向集合，见开放决策）。
3. **可信度顺带交代**（弱信号，非精确数）：批量导入若包含被救援 / 低 `extraction_confidence` 的块，着陆叙事可提示「其中 N 道是低置信抽取，建议回看」——按 ADR-0035 §24「低置信只信相对，不渲染干净的精确数」口径，别把抽取置信度显示成看起来精确的百分比承诺。

> 着陆的「叙事 vs 一句话」详略由 claude design 定；功能约束是**必须交代产出 + 给下一步出口**，不能像现在一样静默跳走。

### ② rescue 失败态

救援是 owner 授权的、付费可见的、可选的人工补救（`rescue.ts:28-30` 头注：**不是自动 fallback**）。失败叙事要素：

1. **锚定到块**：哪个块的哪个 tier 救援失败（现在是全局一行，分不清是哪个块）。
2. **可重试**：失败后能就地重试（同 tier 或升 tier）——救援是 Vision 调用，偶发失败应可再试一次。
3. **区分错误语义**（若暴露富策略）：「这条没救出来（extraction_failed / Vision 返回 0 块，`rescue.ts:100-103`）」vs「这种救援方式还没做（501 not_implemented，`rescue.ts:45-51`）」——两者的下一步不同（前者重试 / 换 tier，后者无能为力，别让 owner 反复点）。
4. **兜底逃生口**：救援反复失败时，owner 仍可手动编辑该块的题面 / 错答（块编辑器字段已可编辑），或忽略该块（`忽略本块` 复选框，`VisionTab.tsx:878-885`）继续导入其余块。失败叙事应把「救不出来就手动改 / 忽略」这条出口讲明。

### ③ phase0 边缘退化态（**显式功能约束** —— 单列）

这四条是**功能约束**，不是可选润色。每条都要有「告诉 owner 发生了什么 + 下一步」的退化态，不能是当前的裸报错 / 静默：

| 退化态 | 现状（裸） | 功能约束（要呈现什么） |
|---|---|---|
| **figure crop 无回显** | 图抠了、存了、route 返了，UI 不显示（`BlockRow` 无 `figures` 字段） | review 时**显示**这道题抠出的图（缩略），让 owner 确认「抠对了 / 挂对了」；抠空 / 挂失败也要可见。**注**：需后端补可服务的 figure 资产端点（见基础设施缺口）。 |
| **PDF 超时不真取消** | 同步渲染、无取消、只能等超时报错 | 展开 PDF 期间给**可取消**的入口；取消要**真停**（不是只切 UI、后端仍在跑）。超时报错要说清「PDF 太大/太慢（>30s 或 >15 页上限），换更小的 / 拆页上传」。**注**：真取消需后端 abort 路径（见基础设施缺口）。 |
| **DOCX 绕过结构** | 文本线无结构树、无核对层，直接产出可编辑块 | 文本线完成态要讲清「这是 pandoc 直接切题（无 OCR/VLM、无结构核对），切题边界请人工核对」；切出的块多 / 少于预期时 owner 能感知是切题问题而非内容问题。视觉存证页图（DOCX 转换也渲染了存证页，`VisionTab.tsx:646-648`）可作为人工核对的参照。 |
| **空块** | 一行裸文字「没产出任何块」 | 空态要给**原因猜测 + 出口**：可能是 OCR 没识别到题目 / 图太糊 / 非题目页 → 引导「换张更清晰的图重试」或「转手动录入兜底」，而不是让 owner 卡在死胡同。 |

---

## 空态 / 失信兜底 / 故障态（显式功能约束汇总）

> 与上面 §③ 表呼应，这里统一列出本面所有非 happy-path 约束，claude design 必须为每条出视觉态，不能只画成功路径。

- **空态**：
  - 抽取产出 0 块（`VisionTab.tsx:687-689`）—— 原因猜测 + 重试 / 转手动出口。
  - 成功导入 0 道（理论不可达，import 至少保留 1 块，`VisionTab.tsx:452`）—— 不需要专门态，但着陆叙事的产出计数要能显示 0 而不崩。
- **失信兜底**：
  - 低 `extraction_confidence` / 经救援的块 —— 按 ADR-0035 §24 口径作弱信号提示，别渲染精确置信度。
  - figure 挂载失败 / 抠空 —— 可见，不静默吞。
- **故障态**：
  - 抽取失败（SSE `ingestion.extraction_failed`，`VisionTab.tsx:213-220` → `phase='error'`）—— 现有 error 态（`VisionTab.tsx:744-753`）只有「失败：<msg>」+ 重置；应给「重试 / 换文件 / 转手动」逃生口。
  - 恢复进行中录入失败（坏 / 过期 `?ingest=` id，`VisionTab.tsx:250-255`）—— 同上，给逃生口。
  - rescue 失败（§②）。
  - PDF / DOCX 展开失败（`startMutation.onError`，`VisionTab.tsx:362-369` → error 态）—— 报错要可读、给下一步。
  - 知识点加载失败（`VisionTab.tsx` knowledgeQ / `RecordPage.tsx:234-240`）—— 现有 `ApiAuthError` 提示「请重新进入页面输入 token」要保留语义。

---

## 数据契约（wire 形状 + 真实 sample，no-mock）

### import 成功响应（出口叙事的数据源）
`POST /api/ingestion/[id]/import` → `import.ts:552`：
```json
{
  "question_ids": ["clq8x2k0a0001abcd", "clq8x2k0a0002efgh"],
  "mistake_ids":  ["cla7m1n0b0001ijkl", "cla7m1n0b0002mnop"],
  "record_ids":   ["clr3p9q0c0001qrst", "clr3p9q0c0002uvwx"]
}
```
三数组等长，长度 = 本次导入的题数。`mistake_ids[i]` 实为 attempt 事件 id（对客户端不透明，`import.ts:10`）。

手动错题表单 `POST /api/mistakes` → `RecordPage.tsx:111`（单条）：
```json
{ "question_id": "clq...", "mistake_id": "cla...", "record_id": "clr..." }
```

### review 块行（退化态的数据源）
`GET /api/ingestion/[id]/blocks` → `rows: BlockRow[]`（`blocks.ts:55-62` 选列；客户端类型 `VisionTab.tsx:89-114`）。真实形状：
```json
{
  "id": "clblk00001",
  "ingestion_session_id": "clsess0001",
  "source_asset_ids": ["classet0001"],
  "page_spans": [{ "page_index": 0, "bbox": { "x": 0.08, "y": 0.12, "width": 0.84, "height": 0.21 }, "role": "stem" }],
  "extracted_prompt_md": "下列函数中，在区间 (0, +∞) 上单调递增的是…",
  "structured": { "id": "...", "role": "standalone", "prompt_text": "…", "options": [{"label":"A","text":"…"}], "answers": ["B"] },
  "reference_md": null,
  "wrong_answer_md": null,
  "image_refs": [],
  "figures": [{ "asset_id": "classet0001-fig-0", "role": "diagram", "attached_to_index": "clblk00001", "source_page_index": 0, "source_bbox": {"x":0.1,"y":0.4,"width":0.3,"height":0.25} }],
  "layout_quality": "partial",
  "extraction_confidence": 0.62,
  "status": "draft",
  "knowledge_hint": "函数单调性",
  "auto_enroll_observation": null,
  "created_at": 1782700000
}
```
> **关键**：`figures` 字段**route 返回了但客户端 `BlockRow` 类型当前没声明、UI 不读**（§③ figure 无回显的根因）。`extraction_confidence`（0..1）与 `layout_quality`（`structured` / `partial` / `text_only`）是失信信号的数据源。

### rescue 响应
`POST /api/ingestion/[id]/rescue` → 成功 `{ "structured": StructuredQuestion }`（`rescue.ts:114` / `api/rescue.ts:43`）；失败走标准 `errorResponse`：
- `422 extraction_failed`（Vision 返 0 块，`rescue.ts:102`）
- `501 not_implemented`（`restructure_cloze` / `restructure_compound`，`rescue.ts:45-51`）
- `404 not_found` / `400 validation_error`（块不存在 / 不属于 session / 无 asset）

---

## 不在本面板范围

- 不改抽取 pipeline 本身的算法（OCR/VLM 分层、figure 门控、切题策略）—— 本 handoff 只管「抽取产出之后的出口与退化叙事」。
- 不做图谱侧的「录入→建节点→可达 frontier」闭环（那是 §2.8a，单独缺口）。
- 不新增题型 / 错因 / 知识点编辑能力 —— 块编辑器现有字段不动。
- 「AI 录入」tab（`AutoEnrolledPanel`，`RecordPage.tsx:64`）的 review 出口是另一条 surface（auto-enroll 观察流），本期出口叙事先覆盖手动 / 拍照 / PDF / DOCX 四条，AutoEnrolled 出口可后续增量对齐。

---

## 边界提醒（给实现者，非 claude design）

- 这是录入面（`/record`，Vite SPA 壳挂 `web/src/router.tsx`），按既有 RecordPage / VisionTab 落地方式接入。
- 动 UI 代码前仍走项目的 design-doc pre-flight；本 handoff + claude design 视觉稿 = pre-flight 的输入。
- 出口叙事的产出计数 / id **已在 import 响应里**，纯前端可做；figure 回显与 PDF 真取消有后端前置（见下）。

---

## 基础设施缺口（needs issue）

以下三条是本缺口实现前需要后端 / 数据支撑的前置，handoff 视觉稿可照常画，但落地需配套后端工单：

1. **figure 资产无可服务的 content 端点** —— `crop.ts:55` 只把裁出的 figure PNG `r2.put('figures/${pageAssetId}-fig-${idx}.png')`，**不建 `source_asset` DB 行**。但 review UI 取图走 `/api/assets/[id]/content`（`asset-content.ts:27-28`：按 `source_asset.id` 查 `storage_key`）—— figure 的合成 id（`classet0001-fig-0`）查不到行，现有端点无法服务。**figure 回显需后端补一条**：要么 crop 时为 figure 建 `source_asset` 行，要么加专用 figure-content 端点。**这是 figure 无回显从「纯 UI」升级为「需后端」的根因。**

2. **PDF 同步渲染无 abort 路径** —— `pdf.ts:55-68` 在路由里同步跑 `renderPdfToPngPages`，30s 超时 + 15 页上限是仅有的边界（`pdf.ts:17-18`）。**「真取消」需后端可中断**：当前同步路由无法被客户端中止（点取消只能切 UI、后端仍跑完）。要么把 PDF 渲染移到可取消的 job、要么加 `AbortSignal` 贯穿渲染。否则 handoff 的「可取消」只能是「假取消（仅切 UI）」——需 owner 拍要不要为此投入后端。

3. **rescue 富策略未实现** —— `rescue.ts:45-51` 仅 `strategy='extract'`，`restructure_cloze` / `restructure_compound` 抛 501。若设计想要「重抽 vs 重组」的富救援菜单，需后端实现这两条策略。当前 UI 未暴露策略选择，可先按「只有重抽 + 升 tier」设计，把富策略列为 gated-future。

---

## 留 owner 拍的开放决策

1. **成功着陆的去向集合**：现状单一硬跳 `/mistakes`。多出口应包含哪些（看错题本 / 继续录下一批 / 去练刚录的 / 回工作台）？是否要「继续录入」作为默认停留（批量录题时不想每道都跳走）？
2. **着陆 vs 一句话 toast**：成功出口是一个**停留的着陆视图**（owner 主动选下一步），还是一个**带产出摘要的瞬时确认 + 仍自动跳**（更轻、但少了「停下来看产出」的机会）？这关系到录入是「一次一道」还是「一批多道」的主用法——claude design 需要这个定调才能定形态。
3. **figure 回显的投入边界**：figure 回显需后端补端点（缺口 1）。owner 是否现在就要 figure 可见，还是先把 figure 当「已抠存证、暂不回显」延后，本期出口叙事先做①②④？
