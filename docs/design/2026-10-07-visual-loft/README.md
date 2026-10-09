# YUK-1353 视觉方向原型

一次性原型，用来回答一个问题：**TS 迁移与 UI 重写采用什么视觉方向与结构**。
第二轮在 owner 的讨论与认可下，做成了一套贴近真实产品的完整方案，而不是并列的变体。

- Pre-flight：[../2026-10-07-yuk1353-visual-loft-preflight.md](../2026-10-07-yuk1353-visual-loft-preflight.md)
- **决策文档（UI 票必引）**：[../2026-10-07-ui-visual-direction.md](../2026-10-07-ui-visual-direction.md)
- 评分表：[scorecard.md](scorecard.md)；独立复核：[review.md](review.md)
- 第一轮的 A/B/C 三个变体与证据只在 git 历史里（commit `147ce1615`），不再作为引用来源。

## 运行

原型位于 `prototype/`，使用仓库已安装的 React、Vite、KaTeX 与 Playwright；吉祥物的 three.js 0.170 运行时从 CDN 加载。
**它不进生产构建**：

- 生产 SPA 的根是 `web/`，Start 前门在 `server/start/`，都不引用本目录；
- `tsconfig.json` 只包含 `*.ts(x)`；
- Biome 忽略本目录；
- 对照构建证明，有无本目录时，`web/dist` 与 `dist/start` 的产物逐字节一致（review.md §5）。

```bash
pnpm exec vite --config docs/design/2026-10-07-visual-loft/prototype/vite.config.mjs   # http://localhost:5199/
```

- 产品原型：`/`。URL 参数 `?page=home|question|note|library&theme=light|dark`。
- 吉祥物样稿：`/marks.html`（三种形态 × 两种渲染 × 冷暖配色，以及各页面的大小与位置）。
- 快捷键：`⌘K` 命令面板、`⌘J` 学习伙伴、`⌘\` 侧栏、首页 `N` 快速记录。
- 手机布局：把窗口缩到 720px 以下，或用浏览器的设备模式（390×844）。

## 文件

| 文件 | 内容 |
| --- | --- |
| `app.jsx` / `app.css` | 外壳、四个页面、学习伙伴、命令面板、手机标签栏与抽屉 |
| `motion.js` | 连续动画：共享标题形变、飞入与收进去、引用回跳、保持阅读位置 |
| `mascot.jsx` / `mark-gl.js` | 吉祥物：跨页面的单一 WebGL 实例、弹簧定位、朝向、停靠；玻璃风车花模型 |
| `kit.jsx` | 公式渲染、图标、椭圆图形 |
| `data.js` / `fixture.js` | 脱敏数据 |
| `tokens.css` / `base.css` | 候选 token 与基础样式 |
| `marks.html` / `marks.jsx` / `marks.css` | 吉祥物样稿 |
| `capture.mjs` | 证据采集脚本 |

## 证据

由 `prototype/capture.mjs` 在真实 Chromium 中生成（需先启动上面的 dev server；吉祥物用 SwiftShader 绘制）：

```bash
node docs/design/2026-10-07-visual-loft/prototype/capture.mjs shots     # evidence/screens：4 页 × 桌面/手机 × 亮/暗
node docs/design/2026-10-07-visual-loft/prototype/capture.mjs states    # evidence/states：规则涉及的关键状态
node docs/design/2026-10-07-visual-loft/prototype/capture.mjs motion    # evidence/motion：动画进行中的帧
node docs/design/2026-10-07-visual-loft/prototype/capture.mjs video     # evidence/video：桌面与手机完整操作录屏
node docs/design/2026-10-07-visual-loft/prototype/capture.mjs probes    # evidence/probes.json：每条动效主张的实测
node docs/design/2026-10-07-visual-loft/prototype/capture.mjs metrics   # evidence/metrics.json：CLS、交互时长、帧间隔（1× 与 4× CPU，各 3 次）
```

- `evidence/screens/{home,question,note,library}-{desktop,mobile}-{light,dark}.webp`：桌面 1440×900，手机 390×844 @2x。
- `evidence/states/`：
  - 回来时：记下之后、建议展开、侧栏折叠；
  - 学习伙伴：生成中、记录中、已记录；
  - 引用：回答里的“第 5 步”回跳到正文、笔记选区气泡、引用落进对话、页边标记回跳到消息；
  - 命令面板（暗色）；
  - 手机：记录表单、滚动后吉祥物停进顶栏、抽屉一半、抽屉里的引用回跳。
- `evidence/motion/`：共享标题形变（卡片 → 标题、标题 → 卡片、资料行 → 标题）、收进“收进来的”、手机收进“记一下”、引用飞进对话。
- `evidence/video/{desktop,mobile}-flow.mp4`：
  - 桌面：记一下 → 展开理由 → 推迟并撤销 → 继续（形变）→ 引用回跳 → 学习伙伴收起与打开（保持阅读位置）→ 提问（生成到记录）→
    加入建议 → 资料 → 笔记（形变）→ 选中提问（引用飞入）→ 页边标记回跳 → 命令面板回到回来时。
  - 手机：记一下 → 往下读（吉祥物停靠、标签栏收窄）→ 回到顶部 → 继续 → 打开学习伙伴 → 引用回跳 → 返回资料 → 进入题目 → 返回。
- 截图使用 `reducedMotion: reduce` 拍摄静止状态；`states` 中涉及动效的几张、`motion`、录屏、探针与指标保留完整动效。

## 数据

`prototype/fixture.js` 与 `data.js` 依据行为设计 §13 的假设样例构造：长题干椭圆综合题与图形、学校草稿照片（含识别不清的一行）、
五步草稿、作答时间线、“观察到 / 你说过 / 还不知道”的理解、一篇课堂笔记、资料列表与两段对话。没有使用 owner 的原题、草稿或任何真实记录。

## 不做的事

原型没有持久化、测试、错误恢复或真实 API；它是会被丢弃的观察工具。生产实现从决策文档重新构建，不复制原型代码。
