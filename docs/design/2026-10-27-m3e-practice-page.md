# 做题页的 M3E 页面层级与状态呈现

服务「第一天能用」，沿 YUK-1351 / YUK-1473；基线 `b8522db138f7be6c0ebde8fd11726a98c089be96`。
本片接续已合 #2090，仅为项目依据 Google 规范的呈现实现，不代表整页 M3E 或实际作答验收。

## 实施前记录

组件类型：page，现役 `PracticeSolo`；不新建 route 或演示入口。
依据 `docs/design/2026-10-27-m3e-direction-and-migration.md`：

- §4，L78：「中文 fallback、数学内容继续用现有链路，字体同源，不放宽 CSP」。
- §4，L79：「取消玻璃高光作为全局视觉依据；不把所有题目、消息和列表都包成同一种大圆角卡」。
- §5，L87：「一次只推进一个有界 UI 产品片。Astra 是该片唯一 UI writer」。

精确文件：修改 `src/capabilities/practice/ui/solo/PracticeSolo.tsx` 的操作栏静态 class，
`practice-solo.css` 的已有 M3E 作用域呈现、`src/ui-next/tokens.css` 同作用域角色；新增本文。
不写 `usePracticeSubmit`、client/API、Start route、Companion 或 props/callback/条件分支。
旧 `src/ui-next/AGENTS.md` 的 loft 视觉依据及玻璃方向由当前 M3E 计划覆盖；作用域、同源字体、无业务规则保持。
`design-taste-frontend` 的应用界面检查用于源码组织；其风格抽签和浏览器运行不适用本片明确的 M3E/source-only 授权。

## 官方依据与实现映射

2026-10-27 实读 Google [Expressive 研究](https://design.google/library/expressive-material-design-google-research)：
关键动作的显著性、相关内容的分组、熟悉交互和标签须同时保留。该研究不证明本产品效果。
Material typography/color/cards specs 直读仍只返回 JavaScript 提示，不冒称取得完整组件规范。
数值取 Google AndroidX 固定 [0d64d21b](https://github.com/androidx/androidx/tree/0d64d21b2ee80232c76e8ee2c6b8d5373ab03a06/compose/material3/material3/src/commonMain/kotlin/androidx/compose/material3/tokens)
的 `ColorLightTokens` / `ColorDarkTokens` / `PaletteTokens`、`TypeScaleTokens`、`ShapeTokens`、`FilledCardTokens`、`OutlinedTextFieldTokens`。
原文件和 URL/hash 在仓库外 `tlp-audit-artifacts/yuk1473/m3e-practice-page-20261027/official-sources.json`。

| 真实区域 | Google 依据 → 项目映射 | 状态与保留项 |
| --- | --- | --- |
| 页面、题目、材料 | surface → 页面；lowest → 主题目区；low → 支持材料；Shape large 16 用于内容区，属于项目组合而非声称官方 page 组件 | 现有文章/题目 pane、顺序、题号、公式、图与引用保留；不裁切焦点 |
| 页面内容职责 | 标题沿首片 headlineSmall emphasized；节标题 titleMedium 16/24/500/.2；题干 bodyLarge 16/24/400/.5；提示 bodyMedium 14/20/400/.2 | 同源中文字体，数学字距独立；大小换算为 Web rem，非 dp/sp 设备等价声明 |
| 原生文本作答 | outlined text field 的 CornerExtraSmall 4、onSurface/outline/primary；本项目多行编辑器保留原 label 和控件 | 去除纸面横线；hover/focus/disabled 可区分。无 floating label，不称完整官方 TextField |
| 作答操作栏 | surfaceContainerHigh 与 large 形状，实色背景替代玻璃；主按钮继续首片 medium filled | 原 DOM 顺序、sticky 位置、快捷键、提交禁用判据不变；不改成 toolbar 键盘模式 |
| 判分、确认与参考 | 分组采用 FilledCard 的 highest/medium 角色；结果正文和后续动作同组，参考与记录作为次级层级 | 正确/部分/未知文字和原状态色保留，不用 error 代表答错；无新增状态判断或自动确认 |
| 取题失败、草稿冲突 | 失败 errorContainer/onErrorContainer；冲突 secondaryContainer/onSecondaryContainer 和双方对照区 | 现有 alert/live、retry、自评、保留草稿/另一版本操作不变；不把错误解释为空 |
| 读取/恢复中、窄屏 | 静态占位与内容容器一致；现有 720px 布局边界保留，窄屏减少内边距并让长文本/状态换行 | 占位不是百分比；未存在的空状态不补造。取消本页旧整页入场，不新增 spring 参数 |

新增 tokens 只在 `data-un-m3e="practice-foundation"` 下定义，沿既有 local override → app → system 主题优先级。
新样式同时依赖该根与 `un-ps-*`/既有作答控件，未标记页不变；没有重绑全站旧变量。
原 Button/IconButton/ChipToggle 首片状态不重做；静态 Chip、Judgment 内部动效、选择题专用控件、提示抽屉、图片放大和吉祥物尚未完整迁移。

## 验证边界

本片不加测试，不运行 browser/runtime/DB/provider/paid 或部署。
视觉、键盘、读屏、亮暗嵌套背景、约 390px 窄屏、软键盘及真实作答均 **NOT_RUN**。
颜色配对计算与 AST 比较仅为静态证据，不能替代以上验收；motion physics 的 Web 完整规格仍是缺口。
本地必要检查、唯一独立 Astra R1 与新 exact-head CI 的实际结果随交付更新原票。

本地 typecheck、lint、build、capability-boundaries 与 architecture-deepening 已通过。
lint 的 162 条警告保留；改动文件 5 条 CSS 警告均在未改旧前缀。未改 baseline，依赖边 239/0/39，无新增边。
TypeScript 解析/打印核对：只归一操作栏的静态 `un-glass` class 后与基线一致，余差为 Biome 属性换行；
PracticeSolo 从 1217 到 1212 行，没有业务职责增长。28 组新增颜色配对静态检查通过。
检查原报和 `static-preservation.json` 留在上述外置目录；独立 R1、PR 与 exact-head CI 另记原 Linear 票，不把它们提前报成通过。
