# Worksheet PDF verify — nested page-tree repair (YUK-1529)

#1791 合入部署后，首个真实 worksheet_render job
`cf334749-21fa-4ad8-a685-226f67f63f8d`（30 题数学真题 → 9 页作答卷）
以 `failed_permanent` 完结：`worksheet pdf verify: multiple /Type /Pages
nodes (page tree nesting unsupported)`。未写 blob、未触碰存档 —— 30 条
issuance 完好，无半档。证据 PDF（canonicalize 后字节，SHA256
`b01c8230fef313a07f9c181e8899a838de83e1487db88650de3ea8caa5952097`）与
区域图封存于
`/Volumes/YukovalSBak/yukoval-projects/tlp-local-prod-20260907.sjUaCU/deployment-20261019-yuk1529-pdf-acceptance-f7d8/`。

## 根因

旧 verify 假设全文件只有一个 `/Type /Pages` 对象且其 `/Kids` 直接挂全部
`/Page` 叶子。实测 Skia/PDF m156 产出的页树是嵌套的：root `93 0 obj`
（`/Count 9`，`/Kids [92 0 R 90 0 R]`）→ 中间节点 `92 0 obj`
（`/Count 8`，挂 8 个 `/Page`）+ 末页 `90 0 obj`。旧代码扫到第二个
`/Pages` 对象即抛错，因此真实可达结构被误报为不支持。

## 修复

`src/capabilities/practice/jobs/worksheet_render.ts` 内 `verifyWorksheetPdfInner`
的页枚举改为按 PDF 规范的页树遍历（`collectPageTreeLeaves`）：

- 入口走 trailer `/Root` → catalog（必须是 `/Type /Catalog`）→ `/Pages`
  根节点，而非"全文件找唯一 /Pages 对象"；
- `/Kids` 深度优先序 = PDF 页序，叶子即 `/Page` 序列；`Kids` 数组只许
  `N G R` 引用，非引用 token、悬空引用、gen 与 xref 记录不符的旧代引用
  一律永久失败；
- `/MediaBox`、`/Rotate` 按规范 §7.7.3.3 沿祖先链继承 —— 节点未声明时
  取最近祖先值；叶子两处都没有 → 失败；有效 Rotate ≠ 0 → 失败（锚点
  几何定义在未旋转页面坐标上，旋转页在渲染契约之外）；Rotate 非 90
  倍数 → 坏文件；
- 每个 `/Pages` 节点声明的 `/Count` 与其子树实际解析出的叶子数逐项
  对账（比旧的"根 Count vs Kids 数"更严格的双证），叶子总数再与区域图
  页数对账；
- visited 集合挡重复/环引用，`PAGE_TREE_MAX_DEPTH=64` 挡病态深嵌套；
- A4 MediaBox（±1pt）、四角锚点物理位置（±0.5mm）、区域图一致性校验
  与内容流解释器逐字不变；`canonicalizeWorksheetPdf` 的同长度重写与
  幂等约束不变。

## 库取舍

`@hyzyla/pdfium`（^3.0.0，worker 镜像经 runner stage 已装）不满足替换
条件：其 wrapper 的 `PDFiumPathObject` 只暴露 `type:"path"`，无 path
segments / fill·stroke 颜色 / 描边宽 / bounds，也没有原始内容流接口，
锚点验路径无法用其实现；`canonicalizeWorksheetPdf` 是同长度字节重写，
本质要求自写解析保留。pdfium 最多替代页枚举一半，xref/object 机制仍须
全留 —— 等于加一套引擎不减代码，还引入 WASM init 与 sync→async 边界。
故按批准回退：在既有字节解析上补规范递归，无新增依赖。

## 验证

- `pnpm typecheck`、`pnpm exec biome check`（本文件 0 finding）、
  `pnpm lint`（仅仓库既有 warning）、`pnpm build` 全过。
- 真实运行证据：对封存 PDF + 封存区域图调既有公开
  `verifyWorksheetPdf`（经 `WorksheetRegionMapArchiveBody` 契约解析）：
  PASS，9/9 页，页序 [2,48,59,66,70,75,80,85,90]，逐页 MediaBox
  594.96×841.92pt A4 portrait，36 个锚点实测误差 ≤0.086mm。
- NOT_RUN：无 DB / 容器 / provider / 付费 / TEST 运行；无端到端
  worksheet_render job 重放（真实 30 题 export 与 ≥60 题更大真卷的验收
  由父 lane 安排）；未写测试代码；本机不跑 full `pnpm test`，exact-head
  CI Gate 由 push 后执行。
