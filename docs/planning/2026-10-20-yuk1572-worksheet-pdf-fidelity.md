# YUK-1572 worksheet_render PDF 保真责任归位（pdf-fidelity）

Date: 2026-10-20. Baseline: `58289c056`（origin/main 切出，无父 checkpoint）。
Scope: `src/capabilities/practice/jobs/worksheet_render.ts` +
`src/capabilities/practice/server/worksheet/pdf-{structure,content,fidelity}.ts`（新增）。

## 目标与边界

`jobs/worksheet_render.ts` 1714 行，其中 ~1188 行（原 110–1297 行）是与
pg-boss/浏览器/存档生命周期无关的纯 PDF 字节算法：classic xref/trailer
解析、顶层字典 token 扫描、页树 /Kids DFS（MediaBox/Rotate/Count 继承与
对账）、内容流有界解释器、对象级 canonicalize、A4/锚点/页数硬校验。
本次把该完整责任迁入 `server/worksheet/` 的 pdf-\* 模块；worker 只保留
运行/产物生命周期（浏览器 pass、网络边界、deadline、R2/存档、结果形状）。

不改：网络白名单/timeout/浏览器导航次序、render 状态/幂等/retry 次序、
DB/R2/paid 链、UI/worksheetPrint、geometry/pagination、producer contract
数值（A4 ±1pt、锚点 ±0.5mm、8.5mm 纸边、油墨容差、canonical 时间/字节）。
所有拒绝条件与错误时序逐字保持。

## 模块切分（按真实依赖，不按行数）

| 模块 | 行数 | 责任 | 依赖 |
|------|-----:|------|------|
| `pdf-structure.ts` | 509 | `WorksheetRenderPermanentError`（三层共用，归最底层避免 server↔jobs 环）、`skipLineEnd`/`ClassicXref`/`parseClassicXref`/`objectRegion`、字典 token 扫描（`skipWsAndComments`/`literalStringEnd`/`dictSpanEnd`/`arraySpanEnd`/`valueTokenEnd`/`topLevelDictEntries`/`checkRefTarget`/`requiredIndirectRef` + `PDF_*` 正则）、页树（`declaredMediaBox/Rotate/Count/KidsRefs`/`PageTreeLeaf`/`collectPageTreeLeaves`） | 无 |
| `pdf-content.ts` | 333 | `streamObjectContent`（FlateDecode 解压）、Affine/`compose`/`apply`/`PaintedShape`/`PdfToken`/`contentTokens`/`stripInlineImages`/`interpretPageShapes` | `./pdf-structure` |
| `pdf-fidelity.ts` | 386 | 公开面：`canonicalizeWorksheetPdf`、`verifyWorksheetPdf`、`Worksheet{Anchor,Page,Pdf}*` 类型、A4/anchor 容差常量、`rgbClose`/`bboxCenter`/`measureDrawnAnchors`；re-export `WorksheetRenderPermanentError` 使本模块为唯一公开面 | `./pdf-{structure,content}` |
| `jobs/worksheet_render.ts` | 547（原 1714） | origin 白名单、浏览器 pass、deadline/signal、R2 写入、write-once 存档、job handler；re-export 六个既有导出保旧导入路径兼容 | `./server/worksheet/pdf-fidelity` |

依赖方向 fidelity → content → structure、fidelity → structure，无环；
structure 零 import。

## 兼容面

- `canonicalizeWorksheetPdf` / `verifyWorksheetPdf` /
  `WorksheetRenderPermanentError` / `WorksheetAnchorMeasurement` /
  `WorksheetPageVerification` / `WorksheetPdfVerification` 仍可从
  `jobs/worksheet_render` 导入（re-export），签名与语义未动。
- manifest 动态入口 `buildWorksheetRenderHandler` 不变；外部无其他直接
  import（grep 已核）。

## 字节对照（证据）

- 原 110–1297 行的每一行在三个新模块中逐字存在（多重集 comm 对照，
  仅 `export ` 前缀差 9 处：`ClassicXref`/`parseClassicXref`/`objectRegion`/
  `requiredIndirectRef`/`PageTreeLeaf`/`collectPageTreeLeaves`/
  `PaintedShape`/`streamObjectContent`/`interpretPageShapes`）。
- worker 保留区（1–40、42–108、1299–1714）逐字未动；差异仅 +21 行
  import/re-export/指路注释与 −1188 行迁出。
- 证据外置：`tlp-audit-artifacts/architecture-deepening/yuk1572/<head>/`。

## 验证状态

- `pnpm exec biome check <4 files>`：通过（format 修正仅落在本次新写行）。
- `pnpm typecheck`：通过（两份 tsconfig）。
- `pnpm build`：通过（web + server/worker/migrate.cjs 全产物；
  INEFFECTIVE_DYNAMIC_IMPORT 与 178 lint warnings 为既有 baseline）。
- 运行验证：**NOT_RUN**（任务约束：无 Playwright/DB/Docker/provider；
  本机不占 runtime，mainline phase2 重启中）。
- 测试：未新增/修改/删除（owner 规则 + 本任务边界）。
