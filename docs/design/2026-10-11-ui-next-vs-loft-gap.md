# ui-next 与 loft 设计语言的差距（做题页重建前的基座补齐）

日期：2026-10-11。票：Refs YUK-1473。

- 对照对象：
  - loft 原型 `docs/design/2026-10-07-visual-loft/prototype/`，以及它的证据图（`evidence/motion`、`evidence/states`、`evidence/screens/question-*`）；
  - 决策文档 `docs/design/2026-10-07-ui-visual-direction.md`：§7 B1–B4、§9 M*、§8 T*、§9A A*、§4 R1/R5/R9、§5 C1–C4。
- 被检查对象：`src/ui-next/`，基线 commit `ec4d42dad`（origin/main）。
- 背景：第一版做题 + 学习伙伴页面是在 ui-next 上搭的，没有吉祥物，也没有形变，被 owner 否决。
  owner 说新设计是「有吉祥物，无缝动画，良好UI层级设计的那个」，也就是 loft。
  本文先列出 ui-next 缺什么，再按优先级补齐，补齐后做题页才能在上面重建。

状态的含义：**有** = 行为与 loft 一致；**部分** = 机制在，但缺了做题页要用的那一段；**无** = 没有实现。
“本分支”一列记录 `yuk-1473-loft-base` 分支补上了什么。

## 差距表

| loft 能力 | 规则 | 基线状态 | 基线证据（file:line） | 本分支 |
| --- | --- | --- | --- | --- |
| 吉祥物：跨页面只有一个实例 | B1 | 无 | 只有 z 值 `tokens.ts:10`、`tokens.css:108`，没有任何组件使用 | 已补：`mascot/MascotProvider.tsx` 由 `UiNextRoot` 挂载，全局一个 |
| 吉祥物：弹簧移动、缩放到页面声明的位置 | B1、T4 | 无（只有弹簧参数） | `tokens.ts:33-34` 有 `SPRING.float`，`motion/spring.ts:30-78` 有一维弹簧，没有人用它定位吉祥物 | 已补：`<MascotSlot size>`，x/y/缩放三根弹簧 |
| 吉祥物：静止朝向读者，偏转上限 x 22° / y 28° | B2 | 无 | — | 已补：`mascot/orientation.ts` |
| 吉祥物：指针 300px 内转向它，离开回正 | B2 | 无 | — | 已补 |
| 吉祥物：手机滚动时停进顶栏，往回滚回到 banner | B3 | 无 | `AppFrame.tsx:61` 的顶栏没有停靠位 | 已补：`<MascotDock>` |
| 吉祥物：在想时风车转动 | B2、C3 | 无 | — | 已补：`useMascotActivity(thinking, settleKey)` |
| 吉祥物：记录完成时前进一格花瓣 | B2、C3 | 无 | — | 已补：同上，`settleKey` 变化即前进一格 |
| 吉祥物：three.js 懒加载、空闲时初始化、只在需要时绘制 | B4、M1 | 无（也没有依赖） | `package.json` 没有 `three` | 已补：`mascot/flower-gl.ts` 动态 import；依赖单独 commit，待迁移线批准 |
| 吉祥物：静态图退回（无 WebGL、软件渲染、减少动态效果、低性能） | B4 | 无 | — | 已补：`mascot/support.ts` 判定，`mascot/FlowerStill.tsx` 是同一朵花的仓库内 SVG |
| 形变：卡片 → 标题 | M4 | 部分 | `motion/flights.ts:63-141` 有快照与播放，但在提交阶段测量，迫使整页同步排版（决策 M4 指出的 4× 降速瓶颈）；没有 React 入口；页面其余部分没有“只淡入不位移” | 已补：`useSharedMorph`，首帧后再测量；`un-page-enter` |
| 形变：资料行 → 标题 | M4、L3 | 部分 | 同上；列表行自己的入场动画会挪动落点，原型 `motion.js:69-71` 有处理，基线没有 | 已补：落点所在行的入场动画被关掉 |
| 形变：标题 → 卡片（返回） | M4 | 部分 | 同上，机制对称，但没有入口 | 已补：同一个 `useSharedMorph`，返回前调用 `capture()` |
| 飞入：引用落进对话 | M6 | 部分 | `flights.ts:163-243` 的 `flyTo` 能追踪移动的落点；缺引用副本的样式和“落地前隐藏目标” | 已补：`flyQuote()` + `.un-quote-ghost` |
| 飞入：记下的内容收进“收进来的” / 手机“记一下” | M5 | 部分 | `flyTo` 的 `shrink` 弧线 `flights.ts:220-229` 与 `bump` `flights.ts:246-256` 在；缺飞行芯片样式；标签栏没有可定位的落点 `TabBar.tsx:37-56` | 已补：`flyCapture()` + `.un-fly-chip`；标签图标带 `data-tab-target` |
| 保持阅读位置 | M7 | 有 | `motion/reading.ts:9-42`，`AppFrame.tsx:38-45` 在面板开合与侧栏折叠时调用 | 不变 |
| 学习伙伴 C3：同一元素 在想 → 生成中 → 记录中 → 已记录 | C3 | 无 | `CompanionPanel.tsx:15-21` 只是容器，没有消息与阶段 | 已补：`CompanionMessage`（徽标、光标、记录细线、✓ 已记录后收起） |
| 学习伙伴头部“在这里 / 在想…” | C1 | 无 | 头部只是插槽 `CompanionPanel.tsx:18` | 已补：`CompanionStatus` |
| 提交 → 判定的过渡 | R3、C3 | 无 | — | 已补：`Judgment`（核对中细线 → 结果芯片原地着色，说明区展开） |
| 玻璃只给浮层 | T3、A3 | 有 | `tokens.css:266-277`；用在命令面板 `CommandPalette.tsx:109`、标签栏 `TabBar.tsx:31`、提示条 `Toaster.tsx:71`；抽屉、学习伙伴侧栏不用玻璃 | 不变；新增的引用副本与飞行芯片不用玻璃 |
| 层级栈：页面 / 卡片 / 吉祥物 / 抽屉 / 面板 / 提示条，用命名 z | T7 | 部分 | `tokens.ts:9-17`、`tokens.css:107-114` 有命名 z；飞行副本借用提示条的 z `flights.ts:37,181`；外框与主框没有自己的底色 token（暗色应为 `#111010` / `#1a1918`，基线用 `bg-sunk` / `bg-raised`，`components.css:290,311`） | 已补：`--un-z-flight`、`--un-z-page`、`--un-z-raised`、`--un-bg-app`、`--un-bg-frame` |
| 手机标签栏：往下读收窄，往回滚恢复 | N3、M8 | 部分 | 有 `compact` 属性 `TabBar.tsx:22`，但收窄时文字不收起 `components.css:554-556`；没有按滚动方向收窄的逻辑 | 已补：收窄时文字收起、图标居中，只动 transform/opacity；`useScrollCondense`。与原型的差别：原型把左右边距收到 18%（布局过渡，M8 不建议），这里用整体缩放 |
| 手机标签栏：抽屉一半或全屏时让位并 inert | N3、A1 | 有 | `TabBar.tsx:24,35`、`components.css:558-561` | 不变 |
| 手机抽屉：三停靠点、带速度弹簧、甩动、取消按松手、键盘到达所有停靠点、露出时正文 inert | C2、A1、A4 | 有 | `BottomSheet.tsx:46-244` | 不变 |
| 手机抽屉：引用回跳前先降到露出 | R1、C4 | 部分 | 抽屉本身可以被设为 peek，但先降再滚动的顺序由页面编排 | 不变（页面层，做题页实现） |
| 引用回跳与亮显、再次跳转重新计时 | M6 | 有 | `motion/reveal.ts:9-21` | 不变 |
| 减少动态效果：所有过渡直接切换，吉祥物不转 | M3 | 部分 | token 归零 `tokens.css:194-202`，飞行跳过 `flights.ts:87,172`；没有吉祥物 | 已补：减少动态效果时吉祥物用静态图，位置直接跳 |
| token：颜色 | T1、T5、A3 | 有（有意偏离） | 色阶与原型一致；按 A3 调深了 `--un-accent-strong #a44527`、`--un-positive #376b46`、`--un-caution #855a0e`（`tokens.css:30,34,36`），原型是 `#b04c2c` / `#3f7a52` / `#8f6210` | 不变 |
| token：字号、字重、行高 | T1 | 有 | `tokens.css:49-61` 与原型 6 档一致 | 不变 |
| token：圆角 | T1 | 有 | `tokens.css:77-79`（8 / 14 / 999） | 不变 |
| token：阴影 | T3 | 有（微调） | `tokens.css:43` 的浮层阴影比原型略深，配合 86% 玻璃 | 不变 |
| token：时长与曲线 | T4 | 部分 | 三条曲线 `tokens.css:102-104` 与原型一致；形变时长 540ms 只在 TS `tokens.ts:25`，CSS 没有 `--un-t-flight` | 已补：`--un-t-flight` |

## 先补哪些（按做题页的需要排序）

1. **吉祥物系统**（B1–B4）。owner 否决第一版的首要原因。一个实例、页面声明位置、弹簧移动、朝向、手机停靠、在想与记录完成、懒加载、静态退回。
2. **学习伙伴 C3 消息阶段与头部状态**。做题页的帮助全在学习伙伴里，回答从第一个字到“✓ 已记录”必须是同一个元素；吉祥物的转动和前进一格由同一个运行状态驱动。
3. **共享标题形变的 React 入口**（M4）。从题目流进入一道题（卡片 → 标题）和返回（标题 → 卡片）；测量推迟到首帧之后，避开 4× 降速下的切屏瓶颈。
4. **提交 → 判定的过渡**（R3）。确定性核对结果原地出现，不跳页、不弹窗。
5. **引用飞进对话**（M6）。从题干或草稿选中一段问学习伙伴。
6. **层级与表面 token**（T7、§8.1 暗色外框）。飞行副本有自己的层，外框与主框有自己的底色。
7. **手机标签栏收窄逻辑、记下飞进“记一下”**（N3、M5）。做题页用得少，顺手补齐。

## 本分支的核验

- 在无头 Chromium（真实 GPU，ANGLE Metal）里驱动展示页的生产构建：
  - 玻璃花渲染成功，在 96px 与 128px 的位置之间用弹簧移动、缩放；落定后裁到阅读列内；随页面滚动贴着位置走。
  - 卡片 → 标题、标题 → 卡片的形变都飞完，没有残影。
  - 引用飞进对话；回答依次走过 在想… → 生成中 → 生成完毕 · 正在记录 → ✓ 已记录，吉祥物同步转动、前进一格。
  - 提交 → 正在核对 → 结果原地着色，说明区展开。
  - 手机宽度往下滚：花停进顶栏、标签栏收窄；往回滚：花回到 banner、标签栏恢复。
  - 减少动态效果：显示静态花，形变不飞，没有残影。页面错误为 0。
- 打包：three.js 只在懒加载的 `flower-gl` chunk 里（约 494 kB，gzip 约 124 kB），入口 chunk 里没有。
- 软件 WebGL（SwiftShader）下同样驱动一遍：判定为 `software-renderer`，用静态花，不加载 three.js；移动、停靠照常，页面错误为 0。
- 生产构建（`pnpm build`）的 `web/dist` 与 `dist/start` 里没有 three.js：目前还没有页面引用 ui-next。
- 还没做：真机录屏和 M12 指标（INP、LoAF）。这项随做题页那张票一起验收。

不在本次范围：选区气泡、手机记录表单、命令面板分组（页面层或已有）；中等宽度布局（T8，未决定）；带文章题目的手机形态（R9，未决定）；吉祥物第二轮建模（B6，YUK-1395）。
