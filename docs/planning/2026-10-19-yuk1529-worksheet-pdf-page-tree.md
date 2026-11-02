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

## 修复（含 R1 复审后修订）

`src/capabilities/practice/jobs/worksheet_render.ts` 内 `verifyWorksheetPdfInner`
的页枚举改为按 PDF 规范的页树遍历（`collectPageTreeLeaves`）：

- 入口走 trailer `/Root` → catalog（`/Type /Catalog`）→ `/Pages` 根节点；
- `/Kids` 显式栈深度优先序 = PDF 页序 —— 'enter' 帧携继承上下文、kids
  逆序压栈保声明序、'exit' 帧对账 /Count；任意深度，无递归、无人为层数
  上限；
- visited 集合整个遍历保留、**先 has 后 add**（R1 修复：`Set.add` 返回
  Set 对象，`!visited.add(...)` 恒假、重复检测恒不触发）—— 重复叶子、
  共享子树、环一律永久失败；
- 属性按对象顶层字典真实 key 解析（token 级扫描：括串/hex/嵌套 dict/
  数组整体跳过，字符串或流里偶然的同名字样不冒充属性）；
- `/MediaBox`、`/Rotate` 只有本节点字典确实未声明才沿祖先链继承
  （规范 §7.7.3.3）；**声明而非法** —— 间接引用、malformed、`/Rotate
  0.5` 这类非整数、`/Rotate N 0 R` 这类 ref —— 一律永久失败，不允许
  静默落回继承值。`/Rotate` 全无声明按 0；有效值非 90 倍数 → 坏文件，
  非 0 → 失败（锚点几何定义在未旋转页面坐标上，旋转页在渲染契约之外）；
- 有效 `/MediaBox` 原点必须是 `[0 0]`（含继承值）—— 非零 llx/lly 会
  平移物理纸边而内容流坐标不变，拒绝而非丢原点照算；
- 每个 `/Pages` 节点声明的 `/Count` 与其子树实际解析出的叶子数逐项
  对账，叶子总数再与区域图页数对账；
- `/Kids` 必须是直接数组且只含 `N G R`；前向引用（/Root、/Pages、
  /Kids、/Contents）的 gen 与 xref 记录对账。`/Parent` 反向指针不用于
  遍历、未做一致性验证 —— 树遍历自身提供可达性与页序真相；
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
  `pnpm lint`（仅仓库既有 warning）、`pnpm build` 全过；`pnpm
  audit:schema` / `audit:partition` / `audit:profile` /
  `audit:draft-status` 全过。
- 真实运行证据：对封存 PDF + 封存区域图调既有公开
  `verifyWorksheetPdf`（经 `WorksheetRegionMapArchiveBody` 契约解析）：
  PASS，9/9 页，页序 [2,48,59,66,70,75,80,85,90]，逐页 MediaBox
  594.96×841.92pt A4 portrait，36 个锚点实测误差 ≤0.086mm。
- NOT_RUN：无 DB / 容器 / provider / 付费 / TEST 运行；无端到端
  worksheet_render job 重放与真实存档（原 30 题 export 与 ≥60 题更大
  真卷的验收由父 lane 安排）；未写测试代码；本机不跑 full `pnpm
  test`，exact-head CI Gate 由 push 后执行。
