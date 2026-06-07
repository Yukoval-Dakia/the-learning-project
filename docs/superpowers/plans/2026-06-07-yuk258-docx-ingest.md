# YUK-258 — DOCX 试卷上传 → 文本线 / 视觉线双管线 ingestion

Plan date: 2026-06-07
Branch: `yuk-258-docx-ingest` (base `a9b0fbdc`, contains #332 PDF lane)
Linear: YUK-258
Author: lane planner (subagent)

本 plan 是 lane 实施蓝图，对照 fresh main 现场所写。Map 三维（pdf-reuse / session-blocks /
deploy-converter）的 fact 已逐条核对到源码行；所有「Map 说 X」与实际源码的冲突点在 §9 列出。

---

## 0. 路由判据（确定性，上传时毫秒级）

解包 docx（zip）→ 在 `word/` 下数 OLE 对象的 `ProgID="Equation.*"`（MathType OLE 计数）：

- count > 0 → **视觉线**（MathType 卷：公式是 OLE 图，pandoc/OMML 抽不出 → 走 LibreOffice→PDF→PDFium 页图 → 现有 extract）
- count = 0 → **文本线**（语文 / 纯文本卷：pandoc 直转 markdown 切题）

实测分布（终矩阵背书）：zxxk 数学卷 151/151 MathType 零 OMML；语文卷零公式。判据是
**纯 zip 解析 + 字符串计数**，不调任何外部 binary，可在路由 handler 同步跑（亚毫秒）。

判据实现细节：docx 是 zip，`Equation.3` / `Equation.DSMT4`（MathType）等 ProgID 出现在
`word/embeddings/oleObject*.bin` 的 `[Content_Types].xml` / `word/document.xml` 的
`<o:OLEObject ProgID="Equation.DSMT4" .../>`。最稳的计数法：解 zip 后对
`word/document.xml`（+ `word/document2.xml` 若存在）做 `ProgID="Equation` 子串计数。用
纯 JS zip 库（见 §2 依赖决策），**不 spawn**。

---

## 1. 文件级改动清单

### 创建（核心新增）

| 文件 | 职责 |
|---|---|
| `src/core/limits.ts`（**改**，见下） | 加 `MAX_DOCX_UPLOAD_BYTES` + `MAX_DOCX_PAGES`（对齐 `MAX_PDF_PAGES`=15） |
| `src/server/ingestion/docx/route-classify.ts` | 路由判据：zip 解包 + MathType OLE 计数 → `'text' | 'visual'`。纯函数，无 IO 外部调用 |
| `src/server/ingestion/docx/convert.ts` | **转换器 seam**（§2）：`docxToMarkdown()`（pandoc）+ `docxToPdf()`（LibreOffice）。binary 探测→docker fallback→test mock 三态 |
| `src/server/ingestion/docx/markdown-segment.ts` | **文本线切题器**（§3）：markdown → `StructuredQuestionT[]` + 原位图引用 + 定界规范化 + 噪声过滤 |
| `src/server/ingestion/docx/persist-page-evidence.ts` | 原图同步存储不变式（§4 铁律）：每份 docx 都过一次 LibreOffice→PDF→PDFium 页图，存 `source_asset`，文本线也存（VLM 兜底有图可读） |
| `src/server/session/docx-ingestion.ts` | 文本线 session 生命周期 owner（§5）：`initiateDocxTextUpload()` —— 直接写 blocks，**不走 `enqueueExtraction`/pg-boss**；视觉线复用 `initiateUpload`+`enqueueExtraction` |
| `app/api/ingestion/docx/route.ts` | 专用上传端点（§5）：multipart → classify → 两线分叉 → 返回 `{ session_id, line, page_count }` |
| `src/ui/lib/assets.ts`（**改**，见下） | 加 `expandDocx()` client caller（POST /api/ingestion/docx） |

### 创建（测试）

| 文件 | 分区 |
|---|---|
| `src/server/ingestion/docx/route-classify.test.ts` | unit（zip fixture，无 DB） |
| `src/server/ingestion/docx/markdown-segment.test.ts` | unit（预转换 markdown fixture，无 DB） |
| `src/server/ingestion/docx/convert.test.ts` | unit（seam mock，**禁真转换**） |
| `app/api/ingestion/docx/route.test.ts` | db（testcontainer，seam mock-before-import） |

### 修改（既有）

| 文件 | 改动 | 与 #333 冲突风险 |
|---|---|---|
| `src/core/schema/structured_question.ts` | `StructuredQuestionSource` enum **末尾**加 `'docx_text'` | **高** —— #333 在 `'tencent_ocr'` 后插 `'glm_ocr'` 并把 inline `source?:` union 换成 `z.infer<...>`。本 lane **加在 enum 末尾**（`'agent_edit'` 后），**绝不动 inline union 那一行**。见 §9.A |
| `src/core/schema/business.ts` | `IngestionEntrypoint` enum 加 `'docx'`（视觉线复用此值进 `initiateUpload`；文本线不进该函数） | 低（#333 不动该 enum） |
| `src/server/session/ingestion.ts` | `InitiateUploadParams.entrypoint` 联合类型加 `'docx'`（line 566） | 低 |
| `src/ui/components/VisionTab.tsx` | `accept` 加 `.docx`；`startMutation` 加 docx 分叉（§6） | 低 |
| `src/core/limits.ts` | 加 docx 常量 | 低 |
| `Dockerfile` | runner 层 apt 加 `pandoc` + `libreoffice`（headless）| 无 |
| `.env.example` | 文档化 `DOCX_CONVERT_ENGINE` / docker fallback 镜像名 | 无 |

> **未触及**：`scripts/worker.ts` / `src/server/boss/handlers.ts`。文本线不进 pg-boss；视觉线复用
> 既有 `tencent_ocr_extract` handler（asset_ids 是普通 image，引擎无关）。Map「deploy-converter」
> 提的 sidecar / 新 worker 方案**不采用**（§9.C）。

---

## 2. 转换器 seam 接口设计（三态：binary → docker → mock）

`src/server/ingestion/docx/convert.ts`：

```ts
// 转换器 seam。生产=镜像内置 binary；本地 dev=binary 探测失败 fallback docker run；
// 测试=注入 mock，禁真转换。所有外部进程调用收口在此文件，其余管线引擎无关。

export interface DocxConverter {
  // 文本线：docx → gfm markdown + 嵌图抽到 mediaDir（pandoc --extract-media）
  docxToMarkdown(input: Uint8Array): Promise<{ markdown: string; media: Array<{ path: string; bytes: Uint8Array }> }>;
  // 两线都用：docx → PDF（视觉线主路 + 文本线存证页图）
  docxToPdf(input: Uint8Array): Promise<Uint8Array>;
}

// 默认实现：探测顺序 binary-on-PATH → docker run fallback。
export function getDocxConverter(): DocxConverter { /* 见下 */ }
```

### 三态探测逻辑

1. **生产（NAS 容器）**：Dockerfile 已 apt 装 `pandoc` + `libreoffice`，`which pandoc` /
   `which soffice` 命中 → 直接 `spawn`（非 spawnSync，async）。
2. **本地 dev**：binary 探测失败 → `docker run` fallback：
   - pandoc：`docker run --rm -i pandoc/core:latest <args>`（stdin/stdout 管 bytes）
   - LibreOffice：`docker run --rm --entrypoint soffice -v <tmp>:/data linuxserver/libreoffice:latest --headless --convert-to pdf --outdir /data /data/in.docx`
     —— **`--entrypoint soffice` 必须显式给**（默认 entrypoint 是 GUI init，会挂）。本地两镜像已 pull。
3. **测试**：`convert.test.ts` 与 route.test.ts 注入 mock `DocxConverter`（返回预转换 fixture
   产物），**禁真 spawn / 禁 docker run**。seam 通过参数注入或 module-level setter 暴露。

### 探测 / 调用约束

- 探测结果**进程级缓存**（`which` 只跑一次）。
- pandoc 调用：`pandoc <in.docx> -t gfm --extract-media=<tmpdir>`。媒体抽到 tmpdir，markdown 内
  `![](<tmpdir>/media/imageN.png)` 引用，切题器据此把图归题（§3）。
- LibreOffice 调用：**超时护栏 60s**（比 PDF 的 30s 宽，docx→PDF 比 PDFium 渲染重；soffice
  冷启 + 字体加载慢）。超时 → `ApiError('validation_error', '...转换超时...', 400)`，killtree 进程。
- 临时文件：`fs.mkdtemp` + `finally` 清理；文件权限**遵守 umask**（`0o666 & ~umask`，不硬编码 mode）。
- seam 文件**不被 worker bundle import**（与 pdf-render.ts 同纪律）——只被 route + docx session owner import。

> **依赖决策**：zip 解析（路由判据 + pandoc media 读取）用纯 JS。优先复用 lockfile 已有
> 的 zip 能力（实施时 `grep -r "jszip\|adm-zip\|yauzl\|fflate" package.json`；若无，加
> `fflate`——零原生依赖、Edge 安全）。**不**为 zip 解析引 LibreOffice/pandoc。

---

## 3. 文本线切题器设计（markdown → blocks）

`markdown-segment.ts`。输入 = pandoc gfm + media 清单；输出 = `StructuredQuestionT[]`
（每个题一个 block 候选）+ 原位 `image_refs`（asset_id 由 persist 后回填）。

### 3.1 题号切分（关键 regex）

pandoc gfm 把行首 `1.` 转义成 `1\.`（避免被当 ordered-list）。默认空 `____` 保留为 `\_\_`。

```ts
// 题号行：行首 N. （pandoc 转义形态 N\. 也吃）。复用 tencent_mark_parser.ts:71 的
// SUB_LEADING_NUM 模式（吃 MarkInfos，仅作结构参考）——这里独立实现吃 markdown。
const QUESTION_LEADING = /^\s*(\d{1,3})\\?\.\s+(.*)$/;       // "1. " 或 "1\. "
const OPTION_LINE      = /^\s*([A-D])\\?\.\s+(.*)$/;          // 复用 tencent OPTION_LINE 形态
const STEM_HEAD        = /^#{1,6}\s+/;                        // markdown 标题 = 大题/篇章头（阅读/完形 stem）
```

切分伪码：

```
lines = markdown.split('\n')
blocks = []; cur = null
for line in lines:
  m = QUESTION_LEADING.match(line)
  if m:                                   # 新题边界
    if cur: blocks.push(finalize(cur))
    cur = { question_no: m[1], prompt_lines: [m[2]], options: [], images: [] }
    continue
  if cur:
    om = OPTION_LINE.match(line)
    if om: cur.options.push({ label: om[1], text: om[2] }); continue
    img = IMG_REF.match(line)             # ![](media/...) 原位
    if img: cur.images.push(img.path); continue
    cur.prompt_lines.push(line)           # 续行拼 prompt
blocks.push(finalize(cur))
```

`finalize` 产出 `StructuredQuestionT`：`role='standalone'`（有 options）或含 `sub_questions`
的 `role='stem'`（STEM_HEAD 下挂多个题号 → 阅读/完形）。`source='docx_text'`，**无 bbox / 无
page_index**（markdown 无坐标，degradation path —— 见 §9.B 与现状先例对齐）。

### 3.2 嵌图归题

pandoc `--extract-media` 把图落 tmpdir，markdown 内 `![](media/imageN.png)` 原位。切题器按
**图出现的题块**把 `media/imageN.png` 归到该题的 `images[]`。persist 阶段（§4）这些图过
`persistImageAsset` 入 R2/`source_asset`，回填 asset_id 到该 block 的 `image_refs`。
跨题边界的图（在两个题号之间）归到**前一题**（题干配图惯例）。

### 3.3 数学定界规范化（关键后处理）

pandoc OMML→LaTeX 直转，但 gfm 输出 GitLab 风格 `` $`...`$ ``（inline）和 ` ```math ` 块。
统一后处理成标准 `$...$` / `$$...$$`：

```ts
// GitLab inline math: $`x^2`$  →  $x^2$
md = md.replace(/\$`([^`]+?)`\$/g, (_, expr) => `$${expr}$`);
// GitLab block math fence: ```math\n...\n```  →  $$...$$
md = md.replace(/```math\n([\s\S]+?)\n```/g, (_, expr) => `$$${expr.trim()}$$`);
```

（文本线判据已排除 MathType 卷，故 LaTeX 量少；但语文卷偶有 OMML 简单式，规范化保证渲染层
统一吃标准定界。）

### 3.4 噪声图过滤

进库前过滤（拿不准默认存——铁律）：

- **微小尺寸**：`width < 50 || height < 50`（sharp metadata 读尺寸）→ 装饰线/项目符号图，丢弃。
- **文档头部**：出现在**第一个题号之前**的图（卷头校名/logo）→ 丢弃。
- **与存证页图 header 哈希重复**：与 LibreOffice 页图（§4）的 header media SHA256 重复 → 丢弃
  （同一 logo 被嵌多处）。
- 其余一律存（content-addressed dedup 在 R2 层兜底，重复 bytes → 同 storage_key）。

---

## 4. 原图同步存储不变式（owner 铁律，两线都执行）

**每份 docx 都过一次 LibreOffice→PDF→PDFium 页图，存 `source_asset`。**

- 视觉线：页图 = extract 输入（喂 tencent_ocr_extract）。
- 文本线：blocks 来自 pandoc markdown；页图**仅存证**（VLM 兜底/人工 review 时有图可读）。

实现（`persist-page-evidence.ts`）：

```
pdfBytes = converter.docxToPdf(docxBytes)            # seam
pages = renderPdfToPngPages(pdfBytes)               # 复用 #332 src/server/ingestion/pdf-render.ts（引擎无关）
for page in pages:                                  # MAX_DOCX_PAGES=15 上限对齐
  row = persistImageAsset(db, r2, { bytes: page.png, mime: 'image/png' })  # 复用 #332
  evidenceAssetIds.push(row.id)
```

- 复用 #332 全套：`renderPdfToPngPages`（PDFium，30s 超时 + 15 页 cap）+ `persistImageAsset`
  （content-addressed SHA256 + R2 + `source_asset` 行）。
- `MAX_DOCX_PAGES = 15` 与 `MAX_PDF_PAGES` 对齐（文本线超 15 页极少；超限 → 同 PDF 的 400）。
- 文本线 `source_document.source_asset_ids` = 存证页图 ids；blocks 的 `image_refs` = 嵌图 asset
  ids（§3.2）。`learning_session.source_asset_ids` = 存证页图 ids（让 review UI 能渲染整页）。

---

## 5. session 生命周期定案

### 视觉线（复用现状，零新代码路径）

```
POST /api/ingestion/docx  (line='visual')
  → converter.docxToPdf → renderPdfToPngPages → persistImageAsset ×N  (= expandPdf 等价物)
  → Ingestion.initiateUpload(db, { assetIds: pageAssetIds, entrypoint: 'docx' })   # status='uploaded'
  → Ingestion.enqueueExtraction({ db, boss, sessionId })                           # uploaded→queued, 投 tencent_ocr_extract
  → 返回 { session_id, line:'visual', page_count }
客户端开 SSE /api/ingestion/[id]/events → extracting → extracted|partial（worker 跑完）→ review/import 复用现状
```

事件序列（既有）：`ingestion.uploaded` → `ingestion.queued` → `ingestion.extracting` →
`ingestion.extraction_completed`（SSE terminal）。UI 不卡 queued —— worker 拉起即 extracting。

### 文本线（新路径，不走 pg-boss / 不走 VLM extract）

`src/server/session/docx-ingestion.ts` 的 `initiateDocxTextUpload()` 在**单事务**内：

```
1. INSERT source_document(source_asset_ids = 存证页图ids, provenance={entrypoint:'docx', line:'text'})
2. INSERT learning_session(type='ingestion', status='uploaded', entrypoint='docx', source_asset_ids=存证页图ids)
3. writeJobEvent('ingestion.uploaded', {asset_count, entrypoint:'docx'})
   # ---- 直达，不经 queued/extracting ----
4. INSERT N × question_block(status='draft', structured=切题产物, source_asset_ids=存证页图ids,
                             image_refs=嵌图ids, page_spans=[{page_index:0, bbox:fullpage}],
                             layout_quality='structured')   # ← critic 改：原 plan 写 'text_only'，见下方 P2
5. UPDATE learning_session SET status='extracted'
6. writeJobEvent('ingestion.extraction_completed', {block_count, layout_quality:'structured'})  # SSE terminal
7. writeSessionEvent(action='extract', subject_kind='source_document', actor_ref='docx_text', outcome='success')
```

**⚠️ P2 修正（critic）：`layout_quality` 必须 `'structured'` 不能 `'text_only'`。**
原 plan 步骤 4 写 `layout_quality='text_only'` 却在步骤 5 强设 `status='extracted'`——**反转了既有不变式**。
实测 `applyExtractionResult`（ingestion.ts:218-219, 188-189）的语义是
`layout_quality='structured' → status='extracted'`；`'partial'|'text_only' → status='partial'`。
本 lane 既要 `status='extracted'`（合理：pandoc 切出的题块有题号/选项/答案，**是结构化的**），
就**必须**配 `layout_quality='structured'`，否则 row 自相矛盾——下游凡按既有惯例
（`status.md`、review 查询、未来 `outcome` 推断 line 223-224）读「`text_only`=降级」的逻辑会误判。
注：UI 不受影响（VisionTab terminal handler line 155-167 只看 event 不看 status，`partial`/`extracted`
都会进 reviewing），故这不是 UI-hang，而是**数据模型一致性** P2。`eventOutcome` 也据此为 `'success'`。

**关键定案**：文本线 `uploaded → extracted` **直达**（不发 `queued`/`extracting`，因为没有异步
worker；切题在 route 同步跑完，sub-秒）。但**必须发 `ingestion.extraction_completed`**——这是
SSE terminal 事件，UI 的 `SSE_TERMINAL`（实测含 `ingestion.extraction_completed`，VisionTab line 123-126）
监听它收尾，否则 UI 卡在 extracting 转圈。

> 为什么不复用 `applyExtractionResult`：它 `assertFromState(['extracting'])`，要求先经
> queued→extracting。文本线无 worker，强行经 queued 会留一个永不被消费的 pg-boss job（ghost）。
> 故新 owner 函数走 `uploaded → extracted` 直达。复用 `applyExtractionResult` 的**写法**
> （block insert 字段、writeJobEvent / writeSessionEvent 形态）保持审计一致，但**不复用其状态机断言**。

事件审计形态对照 `tencent_ocr_extract` handler：`markExtractionStarted`/`Failed` + `writeJobEvent`
—— 文本线对应 `writeJobEvent('ingestion.extraction_completed')` + `writeSessionEvent`，
`business_table='ingestion_session'`、`event_type` 同名，SSE replay 连续性不破。

失败路径：切题产 0 block → route 返回 400（`ApiError('validation_error', 'docx 未能切出任何题', 400)`），
session 不创建（事务回滚），不留半成品。

---

## 6. UI 集成（VisionTab）

> UI 改动仅 `accept` + 一个 mutation 分叉，**无新组件 / 无布局改动**，按 CLAUDE.md 属
> 「改既有组件」但落在已批准 plan 实现步骤内。下方逐条列出 touch 点（均改非创建）。

`src/ui/components/VisionTab.tsx`（`mode='vision_paper'` 分支内）：

- **`accept` 属性**（line ~422）：vision_paper 的 accept 追加 `.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document`。
- **`isDocx()` helper**（新，仿 `isPdf()` line 1045）：查 `file.type` + `.docx` 扩展名。
- **`startMutation`**（line 220 分叉处）：在 `isPdf` 分支**前**加 `isDocx` 分支：
  ```ts
  const docx = mode === 'vision_paper' && selectedFiles.length === 1 && isDocx(selectedFiles[0]);
  if (docx) {
    setPhase('expanding');                         // 复用 expanding phase（label 改「转换 DOCX…」）
    const r = await expandDocx(selectedFiles[0]);  // POST /api/ingestion/docx, 服务端建好 session
    setSessionId(r.session_id);
    setPhase('extracting');                         // 直接进 extracting，听 SSE 收 terminal
    return r.session_id;                            // docx route 已建 session+blocks，不再走 /api/ingestion + extract
  }
  ```
  —— docx 端点**自包含**建 session（与 PDF 不同：PDF 只 expand 出 asset_ids 再走通用
  /api/ingestion）。故 docx 分支**跳过** `setPhase('creating')` + 通用 POST。
- **`expandDocx()`**（`src/ui/lib/assets.ts` 新）：
  ```ts
  export interface DocxIngested { session_id: string; line: 'text' | 'visual'; page_count: number; }
  export async function expandDocx(file: File): Promise<DocxIngested> { /* POST /api/ingestion/docx multipart */ }
  ```
- **phase label**（line 1057 `expanding` case）：docx 时显示「转换 DOCX…」（用一个标志区分 PDF/DOCX，
  或统一文案「转换中…」）。

上限护栏：`MAX_DOCX_UPLOAD_BYTES = 20_000_000`（20MB，docx 比扫描 PDF 小；route 校验，仿
PDF route 的 `MAX_PDF_UPLOAD_BYTES`）。

---

## 7. 测试清单

### 分区纪律

- unit（禁 DB import）：`route-classify.test.ts`、`markdown-segment.test.ts`、`convert.test.ts`（seam mock）。
- db（testcontainer，mock-before-import）：`app/api/ingestion/docx/route.test.ts`——seam + boss + r2 在
  import route module **之前** mock。

### Fixture 生成（预转换产物进 repo，禁真转换进测试）

`tests/fixtures/docx/` + `generate.mjs`（仿 `tests/fixtures/pdf/generate.mjs`）：

- `yuwen-text.docx`（自造，零 MathType）——程序生成（docx 是 zip+xml，用 `docx` npm 或手拼最小
  OOXML；只需 classify 命中 text + 几道带题号/选项/嵌图的题）。
- `math-mathtype.docx`（自造，含 ≥1 个 `ProgID="Equation.DSMT4"` 的最小 OLE）——只为 classify 命中 visual。
- **预转换产物**：`yuwen-text.md`（pandoc gfm 输出，含 `1\.` 转义 + `$\`...\`$` 定界 + `![](media/...)`）
  + `media/` 图——一次性本地真跑 pandoc 生成后 git add，测试读它喂切题器。
- `convert.test.ts` 的 mock `DocxConverter` 直接返回上述预转换 markdown + media bytes。

> **版权红线**：repo fixtures 只用自造样本（程序生成）+ 预转换产物。真卷
> （`/tmp/yuk258-samples/*`、`real-*.docx`）只在 E2E phase 本地用，**绝不 git add**。

### 关键断言

| 测试 | 断言 |
|---|---|
| route-classify | math-mathtype.docx → `'visual'`；yuwen-text.docx → `'text'`；非 zip / 损坏 → 400 |
| markdown-segment | `1\.` 题号正确切边界；A/B/C/D 进 options；`![](media/x)` 归到正确题的 image_refs；`$\`x\`$`→`$x$`；微小图被过滤；文档头图被过滤 |
| convert（mock）| `docxToMarkdown` 返回形状对；超时路径抛 400；seam 注入生效、**无真 spawn** |
| route（db）| text 线：POST → session.status=`extracted`、N 个 draft block、发了 `ingestion.extraction_completed`；visual 线：session.status=`queued`、投了 tencent_ocr_extract job（mock boss 断言 send）；>20MB → 400；0 block → 400 + 无 session 残留 |

---

## 8. commit 切分（4 原子，末位 Closes YUK-258）

1. **`feat(ingestion): docx 路由判据 + 转换器 seam + limits`**
   `route-classify.ts` + `convert.ts`（三态）+ `limits.ts` 常量 + 单测（classify / convert-mock）。
   `Refs YUK-258`
2. **`feat(ingestion): docx 文本线切题器（markdown→blocks）`**
   `markdown-segment.ts`（题号/选项/嵌图归题/定界规范化/噪声过滤）+ `structured_question.ts` 加
   `'docx_text'` source + 单测（含预转换 fixture）。`Refs YUK-258`
3. **`feat(ingestion): docx session 生命周期 + 存证页图 + 端点`**
   `docx-ingestion.ts`（文本线直达 owner）+ `persist-page-evidence.ts` + `app/api/ingestion/docx/route.ts`
   + `business.ts`/`ingestion.ts` 加 `'docx'` entrypoint + route db 测试。`Refs YUK-258`
4. **`feat(ingestion): docx 上传 UI 接入 + Dockerfile 转换器层 (Closes YUK-258)`**
   `VisionTab.tsx`（accept + 分叉）+ `assets.ts`（expandDocx）+ `Dockerfile`（apt pandoc+libreoffice）
   + `.env.example`。`Closes YUK-258`

每个 commit 末尾带 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`；占位 / phase-deferred
代码加注释；Biome 过 touched files。

---

## 9. 风险 + 与 Map 的冲突点

### A. #333（yuk-253-glm-ocr-swap）文件交集 — **最高风险，已实测 diff**

`structured_question.ts` **与** `vitest.shared.ts` 是双方两处交集（原 plan 只列前者；critic
补第二处，见下）。#333 的 diff（已 fetch 核对 `origin/yuk-253-glm-ocr-swap`）：
- 在 `'tencent_ocr'` **后**插 `'glm_ocr'`（enum 中段，line +75..+78）。
- 把 inline `source?: 'tencent_ocr' | ... | 'agent_edit'`（line 104）**替换**成 `source?: z.infer<typeof StructuredQuestionSource>`。

**缓解（enum 块）**：本 lane 把 `'docx_text'` 加在 enum **末尾**（`'agent_edit'` 之后）。
两边改 enum 不同位置（#333 中段、本 lane 尾部）——git 三路合并大概率自动 merge。

**⚠️ P1 修正（critic）：inline union 那一行 _必须_ 改，原 plan「完全不碰」不可构建。**
实测：`StructuredQuestionT.source`（line 104）是**显式字面 union**（TS 类型，非 `z.infer`），
而本 lane 的 `markdown-segment.ts` 要写 typed `source: 'docx_text'`（对照既有先例
`tencent_mark_parser.ts:232 source:'tencent_ocr'`、`structure.ts:177 source:'vlm_structure'`、
`rescue.ts:123`、`block-structured-edit.ts:79`——全是字面赋值）。若只加 enum 不改 line 104，
**`tsc` 直接报错**（`'docx_text'` 不在 union 内）；zod 验证器（line 132 `source: StructuredQuestionSource.optional()`）
会过，但**类型层不过 = gate 第一步 `pnpm typecheck` fail**。
故本 lane **必须**把 line 104 改成 `... | 'agent_edit' | 'docx_text'`（在字面 union 末尾追加，
不碰中段）。这与 #333 把同行重写成 `z.infer` 是**同行硬冲突**——**不可避免，按合并顺序处理**：
- 本 lane 先合：#333 后合时把它的 `z.infer<typeof StructuredQuestionSource>` 覆盖本行即可
  （`z.infer` 自动含双方 enum 新增值，本 lane 的字面追加被 superseded，语义无损）。
- #333 先合：本 lane rebase 时该行已是 `z.infer`，**删掉本 lane 对 line 104 的字面追加**
  （`z.infer` 已自动含 `'docx_text'`，因 enum 末尾那行已 merge），只保留 enum 末尾的 `'docx_text'`。
**合并解冲突规则（写给后合者）**：保留 `source?: z.infer<typeof StructuredQuestionSource>` 形态
 + 保留双方各自新增 enum 值（`'glm_ocr'` 中段 + `'docx_text'` 末尾）。

### B. session-blocks（Map 维度）— 文本线**不能复用** `applyExtractionResult`
Map 说「question_block write paths from extraction handlers」可复用。**冲突**：
`applyExtractionResult` 硬断言 `assertFromState(['extracting'])`（ingestion.ts:211），文本线无
worker、不经 extracting。故新 owner `initiateDocxTextUpload` 走 `uploaded→extracted` 直达，
**复用写法不复用状态机**（§5）。同理 `initiateUpload`（ingestion.ts:566）的 entrypoint 联合类型
只认 `'vision_single'|'vision_paper'`，必须加 `'docx'`——视觉线才用它，文本线不用。

bbox/page_index：Map open question 问「text 块要不要 page_index=0 / dummy bbox」。**定案**：
文本线 block `page_spans=[{page_index:0, bbox:全页}]`（对齐 VisionTab importMutation line 301-304
的 `ensuredSpans` degradation 先例：无 span 时塞 `{page_index:0, bbox:{0,0,1,1}}`）；structured
树本身**不带** bbox/page_index（markdown 无坐标，与 VLM 树 absent 一致）。

### C. deploy-converter（Map 维度）— **不采用** sidecar / 新 worker / docling
Map open questions 倾向「sidecar 容器 or 新 pg-boss handler or docx→PDF→docling」。**冲突 / 收窄**：
- **不开 sidecar**：转换 binary 直接进 app/runner 镜像 apt 层（pandoc ~63MB + libreoffice headless），
  inline spawn，无网络跳。终矩阵已定。
- **不加新 worker**：文本线同步切题（route 内）；视觉线复用既有 tencent_ocr_extract。worker bundle 不动。
- **不用 docling**：终矩阵定 pandoc（文本线）+ LibreOffice→PDFium（视觉线/存证），非 docling。
  `.omx/state/native-stop-state.json` 的 docling 调研是历史，不采用。
- feature flag：本 lane **不引** `DOCX_CONVERSION_ENABLED` 开关（终矩阵未要求；docx 是新增入口，
  默认可用即可）。`DOCX_CONVERT_ENGINE` 仅作 seam 探测的 env override（dev 强制 docker fallback 用），
  非 on/off gate。避免过度工程（CLAUDE.md scope discipline）。

### D. Dockerfile 构建时长 + 镜像膨胀
runner apt 加 `pandoc`（~63MB）+ `libreoffice`（headless，~400MB+ 解压 ~1GB）→ 镜像显著变大、
build 变慢。**缓解**：
- 只装 `libreoffice-core` + `libreoffice-writer`（不装整套 `libreoffice` 元包；Writer 足够 docx→PDF），
  实测体积可砍一半。实施时验 `soffice --headless --convert-to pdf` 在 bookworm-slim + 这两包下可跑。
- apt 层独立 `RUN`（不与 libvips 合并），利用 layer cache。
- 字体：中文卷需中文字体（`fonts-noto-cjk`），否则 LibreOffice 渲染豆腐块 → 存证页图无字。**必装**
  `fonts-noto-cjk`（~100MB）。这是文本线存证 + 视觉线主路的硬依赖，不可省。

### E. LibreOffice 容器调用超时 / 冷启
soffice 首次冷启慢（profile 初始化 + 字体扫描，本地 docker run 可达 10-30s）。**缓解**：
- 超时 60s（§2），比 PDF 30s 宽。
- 生产镜像内 binary 无 docker 冷启开销（进程级 soffice，仍有 profile 首启）；本地 dev 的 docker run
  fallback 最慢，但 dev 可接受。
- 单用户 NAS，无并发；soffice 单实例串行即可，不做 pool。
- killtree on timeout：soffice 派生子进程，超时须杀整个进程组（`spawn` + `detached` + `process.kill(-pid)`），
  否则僵尸 soffice 占内存（对照 pdf-render.ts 的「timeout bounds response not work」CAVEAT，docx 这里
  必须真杀，因为是外部进程不是 WASM）。

### F. 路由判据假阴/假阳
zip 解析失败（非法 docx）→ 当作 400，不猜线。MathType ProgID 字符串变体（`Equation.3` /
`Equation.DSMT4` / 旧版）→ 计数用宽松子串 `ProgID="Equation`。若某卷混排（既有 MathType 又有
可抽文本）→ count>0 一律走视觉线（保守：MathType 公式必须靠页图，文本线会丢公式）。

### G. **vitest.shared.ts 单测注册 — 第二处 #333 冲突面（critic 补，原 plan §7 漏）**
`fastTestInclude`（`vitest.shared.ts`）是**显式 per-file allowlist**，`src/server/ingestion/`
**逐文件枚举**（`crop.test.ts`/`figure_attach.test.ts`/...），**无 `ingestion/**` glob**。本 lane 三个新
unit 测（`docx/route-classify.test.ts`、`docx/markdown-segment.test.ts`、`docx/convert.test.ts`）
若不显式加进 `fastTestInclude`，会被 `vitest.db.config.ts` 的 `allTestInclude`（`src/**/*.test.ts`）
glob 兜进 **db 分区**，在 testcontainer Postgres 下空跑——三者都是纯 no-DB（违 §7「unit 禁 DB import」意图）。
- **影响等级**：P2（非 gate-blocking）。`audit:partition`（`scripts/audit-test-partition.ts`）的 **P0 ERROR**
  只在「**在** `fastTestInclude` 且 import DB 未 mock」时触发；「**不在** allowlist 但无 DB 依赖」仅 **P1 WARN**，
  不返非零 exit。但 `pnpm test:unit:watch` 跑不到这三个测，且它们错落 db 分区拖慢 `pnpm test`。
- **动作**：本 lane **必须**在 `vitest.shared.ts` 的 `fastTestInclude` 加三条
  `'src/server/ingestion/docx/route-classify.test.ts'` 等（或一条 `'src/server/ingestion/docx/**/*.test.ts'` glob）。
- **#333 冲突**：#333 在**同一 `fastTestInclude` 块**加 `glm_ocr.test.ts` + `glm_ocr_parser.test.ts`
  （line +93..+98）。两边都往同 list 追加——大概率自动 merge（不同行）；若冲突按「保留双方各自新增条目」解。
- route db 测（`app/api/ingestion/docx/route.test.ts`）走 db 分区，**不**进 `fastTestInclude`（正确）。

---

## 10. 实施前 pre-flight（lane start 时跑，全 pass 才动手）

```
which pandoc soffice            # 本地可能无 → 预期走 docker fallback
docker images | grep -E 'pandoc/core|linuxserver/libreoffice'   # 两镜像须在（已确认 present）
grep -rE 'jszip|adm-zip|yauzl|fflate' package.json              # critic 实测：fflate ^0.8.2 已在 deps，无需新增
git fetch origin yuk-253-glm-ocr-swap; git diff origin/main...origin/yuk-253-glm-ocr-swap -- src/core/schema/structured_question.ts vitest.shared.ts   # 复核 #333 两处交集
node -e 'require("@hyzyla/pdfium")'                             # 确认 #332 PDFium 可用（存证页图依赖）
```

---

## 11. Critic 修正记录（2026-06-07，plan-critic 定稿）

逐条核对 Map 三维 fact 到源码行 + 审查 6 轴；下列修正已直接 Edit 进上文，VERDICT = **FINAL**（无方向性错误，无 VETO）。

| # | 级 | 位置 | 问题 | 修正 |
|---|---|---|---|---|
| 1 | **P1** | §9.A | 「完全不碰 inline union 那一行」**不可构建**：`StructuredQuestionT.source`（structured_question.ts:104）是显式字面 TS union，`markdown-segment.ts` 写 typed `source:'docx_text'` 会触发 `tsc` 报错（gate 第一步 `pnpm typecheck` fail）。zod 验证器（line 132）过但类型层不过。 | §9.A 改：line 104 **必须**追加 `\| 'docx_text'`；承认与 #333 同行硬冲突，给出双向合并解冲突规则（保留 `z.infer` 形态 + 双方 enum 新增值）。 |
| 2 | **P2** | §5 步骤4-6 | `layout_quality='text_only'` + `status='extracted'` **反转既有不变式**（applyExtractionResult ingestion.ts:218-219：`text_only→partial`）。row 自相矛盾，下游按惯例读「text_only=降级」会误判。 | 改 `layout_quality='structured'`（pandoc 题块确是结构化的），与 `status='extracted'` 一致；event payload + `eventOutcome='success'` 同步。注明非 UI-hang（VisionTab terminal handler 只看 event 不看 status）而是数据模型一致性。 |
| 3 | **P2** | §7 / 新 §9.G | 漏 `vitest.shared.ts` 单测注册：`fastTestInclude` 是显式 per-file allowlist，`src/server/ingestion/` 无 `**` glob → 三个 docx 纯 no-DB 单测会被 db 分区兜走空跑。**且这是第二处 #333 冲突面**（#333 在同 list 加 glm_ocr 测）。 | 新增 §9.G：本 lane 必须把三个 docx unit 测加进 `fastTestInclude`；标 P2（`audit:partition` 对「不在 allowlist 无 DB」仅 P1 WARN 不阻 gate，但影响 watch + test 速度）；给 #333 合并解。 |
| 4 | nit | §10 pre-flight | zip 库探测写成待定。 | 实测 `fflate ^0.8.2` 已在 deps；pre-flight 注明无需新增 + diff 复核加 `vitest.shared.ts`。 |

### 已核验通过（无需改）的关键不变式
- **原图存证两线都落实**：§4 铁律 + §5 两线 `source_asset_ids=存证页图ids`，文本线也过 LibreOffice→PDF→`renderPdfToPngPages`→`persistImageAsset`（实测签名 `persistImageAsset(db,r2,{bytes,mime})` ingestion/persist-image-asset.ts:44 完全匹配）。✓ 不变式未漏。
- **路由判据穷尽性**：§9.F 覆盖 zip 解析失败→400、ProgID 变体宽松子串、混排保守走视觉线。加密/异常 docx 走 400 不猜线。✓
- **session 生命周期一致性**：实测 `SSE_TERMINAL` 含 `ingestion.extraction_completed`（VisionTab:123-126）+ terminal handler 进 reviewing（:155-167）→ 文本线直达 + 发 terminal event 不会卡 queued。`applyExtractionResult` 硬断言 `['extracting']`（ingestion.ts:211）→ 文本线新 owner 不复用状态机的决定正确。✓
- **测试无真转换/真 API + 分区 + fixture 版权**：§7 seam mock + 预转换 fixture + 自造样本、真卷绝不 git add。✓ 红线守住。
- **过度工程砍除**：§9.C 不开 sidecar / 不加 worker / 不用 docling / 不引 on-off feature flag；§3 切题器只独立实现 markdown 切题、接口与「markdown+原位图」同构留给 #333 GLM-OCR 复用——**未**提前做统一切题器。✓ 符合 scope discipline。
- **视觉线复用 #332**：`renderPdfToPngPages(Uint8Array)`（pdf-render.ts:153）+ `MAX_PDF_PAGES=15`（limits.ts:12）+ `enqueueExtraction`→`tencent_ocr_extract`（ingestion.ts:90）+ PDF route flat `{asset_ids,page_count}` 201（pdf/route.ts:72）——全部实测匹配。✓
