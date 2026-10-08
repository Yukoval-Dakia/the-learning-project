# YUK-1353 视觉方向 loft

一次性原型，用来回答一个问题：**TS 迁移与 UI 重写采用什么视觉方向与结构**。
三个变体在信息架构、导航与布局上不同，共用同一套候选 token 与组件词汇，因此差异只来自结构。

- Pre-flight：[../2026-10-07-yuk1353-visual-loft-preflight.md](../2026-10-07-yuk1353-visual-loft-preflight.md)
- **决策文档（UI 票必引）**：[../2026-10-07-ui-visual-direction.md](../2026-10-07-ui-visual-direction.md)
- 评分表：[scorecard.md](scorecard.md)；独立复核：[review.md](review.md)

## 三个变体

| | A 纸页（选定，第二版） | B 工作室 | C 学习线 |
| --- | --- | --- | --- |
| 导航 | 顶栏三去处 + `⌘K`；手机顶层页底部标签栏 | 常驻左侧栏；手机底部标签栏 | 无常驻导航；底部输入式命令条 |
| 首页 | 单栏叙述 + 等大“继续 / 建议”并列 | 约束条 + 两栏面板（你的 / 系统的） | “现在”节点分叉（继续 / 建议 / 停下）+ 学习线时间轴 |
| 工作台 | 文档 + 页边帮助；宽屏题干钉左 | 三栏：题目 / 草稿 / 帮助；手机分段切换 | 题目与草稿双栏 + 底部升起的帮助面板 |

## 运行

原型位于 `prototype/`，直接使用仓库已安装的 React、Vite、KaTeX 与 Playwright；**不进 `pnpm build`**（生产 SPA 根是 `web/`），
`tsconfig.json` 只包含 `*.ts(x)`，Biome 忽略本目录。

```bash
pnpm exec vite --config docs/design/2026-10-07-visual-loft/prototype/vite.config.mjs   # http://localhost:5199/
```

右下角 loft 面板切换变体、屏幕、主题、设备（手机为 390×844 iframe）、数据状态（正常 / 久别 / 空 / 载入 / 出错），
以及“模拟写入失败”以观察乐观写入的回滚。快捷键：`Alt+1/2/3` 变体、`Alt+S` 屏幕、`Alt+T` 主题、`Alt+M` 设备；
产品内 `⌘K` 命令面板、首页回车继续、工作台 `H` 提示 / `E` 讲解 / `D` 草稿 / `⌘↵` 提交 / `[` 返回。
URL 参数可直接定位：`?v=b&screen=work&theme=dark&state=normal&help=1&chrome=0`。

## 证据

由 `prototype/capture.mjs` 在真实 Chromium 中生成（需先启动上面的 dev server）：

```bash
node docs/design/2026-10-07-visual-loft/prototype/capture.mjs shots     # evidence/screens：首屏与整页
node docs/design/2026-10-07-visual-loft/prototype/capture.mjs states    # evidence/states：久别/空/载入/出错/帮助展开/命令面板
node docs/design/2026-10-07-visual-loft/prototype/capture.mjs video     # evidence/video：每变体桌面与手机完整操作录屏
node docs/design/2026-10-07-visual-loft/prototype/capture.mjs metrics   # evidence/metrics.json：CLS、交互时长、帧间隔（1× 与 4× CPU）
```

- `evidence/screens/{a,b,c}-{home,work}-{desktop,mobile}-{light,dark}[-full].webp`：桌面 1440×900、手机 390×844 @2x。
- `evidence/states/`：`{v}-home-{absent,empty,loading,error}`、`{v}-work-help-open-{desktop,mobile}`、`{v}-palette-dark`。
- `evidence/round-1/`：A 第一版（修订前）的首页与工作台，作为修订记录。
- `evidence/video/{v}-{desktop,mobile}-flow.mp4`：回来时 → 展开理由 → 推迟并撤销 → 继续 → 写一步 → 提示 2 → 讲解（流式“未生效”）
  → 收起 → 新步骤仍在 → 命令面板返回（手机走返回键）。
- 截图使用 `reducedMotion: reduce` 以避免捕获过渡中间帧；录屏与指标保留完整动效。

## 数据

`prototype/fixture.js` 是依据行为设计 §13 假设样例构造的脱敏数据：长题干椭圆综合题与图形、学校草稿照片（含识别不清的一行）、
五步草稿（三步来自照片、一步看提示后完成、一步正在写且含均值不等式取等陷阱）、已看提示 1 与未开提示 2、
“观察到 / 你说过 / 还不知道”的不确定判断、四个目标、三种准备状态、久别与费用。没有使用 owner 的原题、草稿或任何真实记录。

## 不做的事

原型没有持久化、测试、错误恢复或真实 API；它是会被丢弃的观察工具。生产实现从决策文档重新构建，不复制原型代码。
