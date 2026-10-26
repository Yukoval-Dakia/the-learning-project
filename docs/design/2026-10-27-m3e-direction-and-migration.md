# Google M3 Expressive：当前方向与渐进迁移计划

日期：2026-10-27（Asia/Tokyo）。服务「第一天能用」的界面与后续连续学习体验。
原票：[YUK-1351](https://linear.app/yukoval-studios/issue/YUK-1351)、[YUK-1473](https://linear.app/yukoval-studios/issue/YUK-1473)，均 In Progress。
状态：**方向已决定；本次只交正式文档，M3E 产品实现与运行验收未完成。**

## 1. 当前决定与下一交付

Owner 已明确 UI 设计、实施、视觉复核由 **Astra** 承担，全面采用 **Google Material 3 Expressive（M3E）**，严格依据 Google 官方规范。
[决定原文](https://linear.app/yukoval-studios/issue/YUK-1351#comment-dcadddc1-14ab-4c44-a60f-00809a0588ba)已读回。
不再征求 loft / Linear / Apple Glass / A-B-C 风格选择；不把旧 Opus 评审改署为 Astra 结果。
本文件是当前 UI 方向入口；[旧视觉方向](2026-10-07-ui-visual-direction.md)保留历史正文、原样稿与评审证据。

**下一实施片：M3E 基础在现役做题页落地。** 先在已有 `PracticeSolo` 的真实内容、主操作与状态控件中消费有作用域的 tokens / primitives，
再完成做题+学习伙伴的代表性真实页面，之后推进外壳/今日及其余页面。基础与真实消费者同片交付，不先建一套无人使用的组件框架。
本文件安排后续实施，不是本轮实施或运行授权。

M3E 改变视觉语言与交互呈现，不重新决定选题、判分、建议生效、题目可用性、读写或恢复规则。
[准备计划 §9](../planning/2026-10-07-ts-migration-and-ui-rewrite-prep.md#9-必须存活的-pre-ai-确定性能力承重)的八项 pre-AI 承重能力保持；
已存在的功能、API、鉴权、锁、事务、幂等、paid 与可逆动作合同保持。
不恢复 [ADR-0052 的 NO-GO callback workflow shell](../adr/0052-owner-local-durable-handoff-protocols.md)，
不以迁移数量、页面数量、组件行数等目标制造 pass-through 薄壳，不把领域决策搬到 UI。

## 2. 固定主线事实与未完义务

本次源码核查基线：`93ab3f790ae78652b787b66743d8ae66453921d6`（fresh `origin/main`）。
下表「已合」仅指该基线包含相应提交与真实 consumer；不等于当前 TEST 已部署该 revision，也不等于全链路运行通过。
动态进度继续以原 Linear 票为准，不复制成另一个全局看板。

| 面 | 主线已交事实与可复核路径 | 尚未交 / 运行缺口 | 原归属 |
| --- | --- | --- | --- |
| 设计系统基座 | `src/ui-next/tokens.css`、`components.css`、`primitives/`、`shell/Root.tsx` 已有真实页面消费者；YUK-1354 的旧基座成果保留 | tokens 仍是 `--un-bg: #faf9f5`、`--un-accent: #d97757`、玻璃高光及旧字阶/曲线；不是 M3E | YUK-1354 历史 Done；当前方向在 YUK-1351，首片在 YUK-1473，不因换风格重开 Done |
| 做题 | [#1831](https://github.com/Yukoval-Dakia/the-learning-project/pull/1831)，`615437b76`；`src/capabilities/practice/ui/solo/PracticeSolo.tsx`、`practice-solo.css`，继续使用 `usePracticeSubmit` | 旧纸面布局的源码交付；本轮未运行作答、草稿、判分、申诉、下一题，不作 M3E 或完整业务验收声明 | YUK-1473；transport 为 YUK-1358 |
| 学习伙伴 | [#2020](https://github.com/Yukoval-Dakia/the-learning-project/pull/2020)，`9cf9e2a0a`；`web/src/RootShell.tsx` 经 copilot `ui-public.ts` 消费唯一 `CompanionMount`，内部持有 controller 与恢复生命周期 | 协调线本次交接记录真实验收样本失败，正文流出中 Stop 未验；本轮未复测，不把关闭面板或未发生的流式阶段算停止成功 | YUK-1473 |
| 统一题库 | [#2022](https://github.com/Yukoval-Dakia/the-learning-project/pull/2022)，`9e1e99bc8`；`src/capabilities/practice/ui/library/LibraryPage.tsx`、`QuestionPage.tsx`，`/drafts`、`/mistakes` 已转交统一题库 | 删除/恢复、编辑/审核等真实写路径未完整验收；`use-library.ts` 保有分页、局部已加载错题集合及独立计数语义，不能换成臆造总量 | YUK-1473；reader 接线 YUK-1358 |
| 录入与显式复核 | [#2023](https://github.com/Yukoval-Dakia/the-learning-project/pull/2023)，`45c835c7e`；`src/capabilities/ingestion/ui/record/RecordPage.tsx`、`RecordingSheet.tsx`；[#2031](https://github.com/Yukoval-Dakia/the-learning-project/pull/2031)，`9c190de20`，classic 部分结果显式复核 | 上传、识别、历史、写入全链未闭环；旧 TEST 验收记录中的后端无新 history 路由，404/旧响应不能解释为空历史或验收通过；本轮未探测现环境 | YUK-1473，后端缺口留原迁移/领域线 |
| Start readers | [#2066](https://github.com/Yukoval-Dakia/the-learning-project/pull/2066) `bacf1a0a1`、[#2067](https://github.com/Yukoval-Dakia/the-learning-project/pull/2067) `7b11c8b10`、[#2071](https://github.com/Yukoval-Dakia/the-learning-project/pull/2071) `c42d6b1e8`，以及 [#2086](https://github.com/Yukoval-Dakia/the-learning-project/pull/2086) `629fb1a1`；`server/start/routes/questions.$id.tsx` 注入 question/draft/mistakes readers 与 `() => startWorkbenchClient.getTree()` | 是 transport/reader 交付，不是 M3E 或全量 RPC/写入验收；其余 HTTP、binary、keepalive、SSE 与恢复义务不因本计划消失 | YUK-1358 |
| 外壳 / 今日 | 现役 `web/src/RootShell.tsx`、`src/capabilities/shell/ui/TodayPage.tsx`，Start `workbench-shell.tsx`、`routes/today.tsx` 仍消费现有 UI | 协调线交接的新外壳/今日仅 V3 样稿，未交 M3E main；样稿不是运行页面；旧 A/B/C 待选择已失效 | YUK-1351，相关功能/迁移原票 |

运行权限与缺口的直接记录：YUK-1473 [题库/录入只读边界](https://linear.app/yukoval-studios/issue/YUK-1473#comment-d07389b0-fe94-4b16-b84b-d8f0cdac0bda)、
[伙伴限定真实验收安排](https://linear.app/yukoval-studios/issue/YUK-1473#comment-33db89a1-e3cb-4d18-9a84-35718531ceff)。
这些评论记录当时的环境与许可，不证明现在仍有可用预算、同一部署或未消费的请求额度。

## 3. Google 官方依据与 Web 可用性

检索日期为 2026-10-27 JST。仅引用 Google 官方资料；搜索索引返回的官方正文与直接抓取结果分开记录。
部分 Material 页面直读为 `This website requires JavaScript.`；搜索索引日期异常或旧抓取时间不当作规范发布日期。
本轮没有浏览器读取、下载组件库或验证任何 Web 实现。

| 依据 | 本次确实可获取的内容 / 限制 | 用途 |
| --- | --- | --- |
| [M3 Get started](https://m3.material.io/get-started) | 直读 JS-only；官方域搜索正文可读：M3E 扩展 M3，涵盖组件、emphasized typography、motion physics、shape library | 定义方向覆盖面，避免只给 loft 换色 |
| [Google Design：Expressive 研究](https://design.google/library/expressive-material-design-google-research?pubDate=20250521) | 正文可读：color、shape、size、motion、containment；强调关键动作、分组及功能/可访问性，不能因表现力丢失熟悉交互和标签 | 做题内容与主操作的层级依据；研究结果不是本产品学习效果证据 |
| [Color roles](https://m3.material.io/styles/color/the-color-system) | 官方域搜索正文可读：primary/secondary/tertiary、对应 on/container、surface container 层级、error、outline/outline variant | 建立语义配对，逐一验真实背景上的对比度 |
| [Typography：applying type](https://m3.material.io/styles/typography/applying-type) | 官方域搜索正文可读：display/headline/title/label/body 各 large/medium/small；[overview](https://m3.material.io/styles/typography/overview) 直读 JS-only | 先映射角色，再取具体规格；emphasized 样式不能只靠任意加粗 |
| [Shape](https://m3.material.io/styles/shape) | 直读 JS-only，`/overview` 两次超时；入口证实 expanded shape library，具体组件 shape 数值未取得 | 不凭记忆填圆角、变形路径；组件实现前核其 Specs |
| [Motion physics](https://m3.material.io/styles/motion) | 直读 JS-only；官方域搜索正文可读：expressive/standard schemes，spatial/effects springs，fast/default/slow；Web 可对照 Compose springs，需 Specs 转换 | 代替旧统一时长/缓动规则；本次未取得 stiffness/damping 等参数，不编数值 |
| [Buttons](https://m3.material.io/components/buttons/overview)、[Lists](https://m3.material.io/components/lists/overview)、[States](https://m3.material.io/foundations/interaction/states/overview) | 本次直读 JS-only；未据此确认按钮/list 的完整 Expressive 状态、尺寸与 Web 支持表 | 切片实施时逐组件补读 Specs/Guidelines/Accessibility，并留下映射；未取得前不标完成 |
| [App bars](https://m3.material.io/components/app-bars/) | 官方域搜索正文可读：Expressive 更新及平台 availability；Web 与 Web: Expressive 均列 Unavailable | 外壳后续需项目 Web 实现，不能声称官方现成 Web app bar |
| [Material Web](https://material-web.dev/) | 官方页面搜索可读：`@material/web` 是 Web components；注明 maintenance mode pending new maintainers | 不能推断有全套 Web Expressive，更不能把 MUI 或任意第三方库安装视为 Google 认证 |
| [Google adaptive window size classes](https://developer.android.com/develop/ui/compose/layouts/adaptive/use-window-size-classes)、[Material canonical layouts](https://m3.material.io/foundations/layout/canonical-examples/overview) | Android 官方正文可读，以可用窗口宽/高分类；Material 后者官方搜索可读多 pane 组织。旧候选 Material `applying-layout/window-size-classes` 直读 404，未作有效规范链接使用 | 采用窗口适配原则；Compose API、dp 不能直接当 Web CSS 实现 |
| [Google Web：keyboard focus](https://web.dev/learn/accessibility/focus/)、[color/contrast](https://web.dev/learn/accessibility/color-contrast/)、[motion](https://web.dev/learn/accessibility/motion) | 正文或官方域搜索正文可读；覆盖焦点顺序、文字/图标对比度、非颜色提示和 reduced-motion | 作为 M3 在 Web 上的可访问性实现与实测依据 |

**规范与库分开。** 保持 React/TanStack 与现有可访问性、数学渲染/编辑能力。
采用项目实现时，在该片 pre-flight 记录「官方组件/variant → token/状态/交互 → 本项目文件 → 真实页面证据」，
并明确写“项目实现，依据 Google 规范”。Google 没有现成 Web Expressive 组件的项不能称“Google 全套 Web 库”或“已认证”。
不本轮选库、装 MUI、换依赖或引入一套通用 adapter。需要依赖或拿不到关键规格时，提交精确项与影响给协调线；这不是重新选择设计语言。

## 4. 规范到现役实现的映射

下面右侧是本项目的实施/验收约束，不冒充 Google 已发布的 React 实现或本轮实测。所有数值在实施片由官方 Specs 核实后落 token；
不沿用旧「六级字号、三档圆角、珊瑚强调色、固定毫秒曲线」作为 M3E 默认。

| 维度 | Google 依据 → 项目实现位置 | 后续验收输出 |
| --- | --- | --- |
| Tokens 与作用域 | §3 color/type/shape/motion；`src/ui-next/tokens.css` 保持 `[data-ui-next]`、`--un-*` 命名，避免 Tailwind 命名扫描冲突。新语义角色可命名 `--un-md-sys-*`，仅为项目 CSS 名称。通过 `shell/Root.tsx` 的显式 M3E 标记限定已迁页面；旧消费者暂保旧值 | 列实际 consumer 和旧别名到角色的对应；不能把全站 `--un-accent` 直接改色而影响未迁页。旧别名随最后真实消费者迁出再删除，不留无退出归属的双系统 |
| Color roles / 明暗 | primary/on-primary、container/on-container 等配对；surface 与分层 container 支撑内容/伙伴/浮层；outline 用于必要边界，outline-variant 用于弱分隔。`tokens.css`、`components.css`、页 CSS 逐组件映射；判分语义不硬套 error，现有正确/部分/未知文字保持 | 亮/暗分别覆盖实际嵌套背景；继承现有 theme override → app → system 行为，不建第二套 theme store；普通文字 ≥4.5:1，大字/必要图标 ≥3:1（Google Web 对比度页），逐状态实测，颜色不是唯一信号 |
| Type scale | display/headline/title/body/label 按内容职责映射到 `SectionHead`、题干、答案、`MessageRow`、按钮；emphasized 只用于确需强调的层级，参数需官方规格。中文 fallback、数学内容继续用现有链路，字体同源，不放宽 CSP | 长中文/公式/数字/多行标签可读，缩放与窄屏不截断关键动作；完整记录 size/weight/line-height/tracking 角色，不能只换一款大标题字体 |
| Shape / containment | 使用官方组件 shape、容器分组与强调层级；落 `Card`、`Button`、`Chip`、伙伴面板及页 CSS。取消玻璃高光作为全局视觉依据；不把所有题目、消息和列表都包成同一种大圆角卡 | 关键动作与内容分组可识别，形状变化不裁掉文本、焦点或触达区域；未获取的 corner/pressed 形状规格标待核，不编造 |
| Primitives / 状态 | `Button.tsx`、`IconButton.tsx`、`Chip.tsx`、`Segmented.tsx`、`RetryLine.tsx`、`SkeletonLines.tsx` 按真实用途选官方组件/variant，不机械一一改名。`components.css` 管统一视觉，保留原生元素语义与 props | 每片列 enabled、hover、focus-visible、pressed、disabled、selected 等适用状态（不适用写原因），再列产品 loading/empty/error/partial/stale/retry；禁止把业务 pending 当已提交或自动变成 disabled。Specs 未读到的组件不得声称完整 M3E |
| Motion / reduced-motion | 由 §3 physics 区分 spatial 与 effects，落 `tokens.css`、`motion/` 与组件；expressive scheme 服务主交互，避免正文与输入持续运动。Web spring 转换参数必须有来源；不把旧 cubic-bezier 名称改成 spring 就算迁完 | 动画可中断，大小/位置与 opacity/color 分开；`prefers-reduced-motion: reduce` 取消非必要飞行、弹跳、形变，状态即时或最小淡变到位；CSS 与 JS 共用现有 reduced-motion 判断。关闭动画不改变提交、取消、焦点或完成时机 |
| Adaptive layout | 按可用窗口宽高与内容容量组织，落做题/伙伴 CSS，再外壳/今日。紧凑空间单主 pane；宽屏可容纳支持 pane，但保留伙伴原开合状态与会话，不凭屏宽重置。Web 断点由官方原则与实际内容验证，不把 Android dp 数值机械贴成 px | 桌面、约 390px 窄屏、连续缩放及短高窗口下可完成同一动作；软键盘不遮住输入/主要操作；视觉顺序与 DOM/焦点顺序一致；不新增业务导航或多套查询 |
| Keyboard / focus / accessibility | 原生 button/input/link、明确 label、focus-visible、逻辑 Tab/Shift+Tab；`IconButton` 必有可访问名称。模态层复用现有 focus trap，隐藏区 inert；非模态伙伴不误设全页 trap | 真实键盘、读屏与焦点返回检查；关闭浮层回到触发处；不抢输入法按键，不改快捷键合同；按组件官方 Accessibility 核触达与间距，不能把现有 24/44px 当通用 M3E 合格值；错误/选中/保存均有非颜色说明 |

## 5. 渐进顺序、文件责任与共享接缝

一次只推进一个有界 UI 产品片。Astra 是该片唯一 UI writer；非视觉 transport、路由、领域线继续已批精确工作，不冻结整个 capability 或文件。
组件树中的数据和生命周期代码不是“UI 文件所以全归视觉作者”。合并前按最新 main 对照具体 symbol/hunk，重叠部分顺序交接。

| 顺序 / 交付 | Astra UI 允许准备的修改面 | 现有线保有的部分 / 本片不能顺带改 | 完成证据 |
| --- | --- | --- | --- |
| 基础在做题页落地（最小下一片） | `src/ui-next/tokens.css`、`components.css`、`shell/Root.tsx` 的可选作用域标记；`primitives/Button.tsx`、`IconButton.tsx`、`Chip.tsx` 的有消费状态；`src/capabilities/practice/ui/solo/PracticeSolo.tsx` 仅根标记、标题/主操作语义及 class，`practice-solo.css`。首片不改 public API 导出、不加依赖 | `PracticeSolo` 的 `usePracticeSubmit` 调用、props/callback、草稿/判分/提交/申诉/下一题；`practice-client.tsx`、`practice-api.ts`、`server/start/routes/practice.tsx` 及其已批 client 注入由 YUK-1358 保持 | 官方规格→角色/状态映射，现役做题页真实亮暗/键盘/缩放证据；首片只称“基础/指定控件已迁”，不称整页 M3E 已验 |
| 完成代表页面：做题 + 学习伙伴 | 后续按真实需求扩到 `Segmented`、`Expand` 等已消费 primitives、做题 CSS 与 `src/capabilities/copilot/ui/companion/CompanionPanel.tsx`、`Composer.tsx`、`MessageRow.tsx`、`ContextBar.tsx`、`companion.css` 的呈现；每片列具体文件，非目录授权 | `CompanionMount` 的唯一 controller/常驻挂载、`companion-controller.ts`、`turn-sender.ts`、`run-tracker.ts`、`acceptance.ts`、`turn-actions.ts`、`visit-sessions.ts` 及 server/domain 合同归现 owner。领域缺陷不夹带成视觉重构 | 做题内容/状态+伙伴开关/引用上下文的真实布局；发送/恢复/停止另列实际权限与验收结果；不得借换样式宣布旧失败已修 |
| 外壳 / 今日 | `web/src/RootShell.tsx` 的展示 hunk、`src/ui/shell/AppSidebar.tsx` 及 shell 当前样式的必要 hunk、`src/capabilities/shell/ui/TodayPage.tsx` 与 `shell.css` 的展示；先由协调线明确共享 hunk，再修改 | `server/start/workbench-shell.tsx`、`workbench-client.ts`、`routes/today.tsx`、TokenGate、QueryClient、navigation/epoch/reader 装配归 Start；摘要、费用、排序与下一步决策归领域。不复制 V3 样稿为已完成产品 | 实际入口、摘要/准备/未知费用、断点与焦点证据；导航语义保持；不能为新外壳恢复旧 SPA 或添第二个应用 |
| 其余真实页面 | 先统一题库 `practice/ui/library/` 的行/详情/编辑呈现，再录入 `ingestion/ui/record/` 的列表/详情/复核呈现；其后 notes/knowledge/coach/profile/admin 等按原功能票、真实修改面逐页圈定 | 题库 `library-client.tsx`、`use-library.ts`、`use-question-writes.ts`、`library-api.ts` 的读取/写/失效；录入 `record-api.ts`、`record-start.ts`、`recording-read.ts`、`recording-live.ts`、`recording-model.ts` 的状态/恢复归各线。不以目录独占阻断 transport | 每页都有实际 consumer、完整状态表与旧行为对照；写入/恢复/paid 缺口留原票，不能用静态页面替代 |

最小下一片的作用域标记是现有根上的渐进开关，不是新 design-system registry、展示路由或第二套壳。
未迁页面保留旧基座外观；以后每片消费 M3E 后退出自己的旧样式，不按目标行数批量拆组件。
`src/ui-next/AGENTS.md` 仍含旧视觉引用、命名与 motion 约束：当前视觉冲突由本 owner 决定及本入口覆盖；
作用域、无全局污染、同源资源、无业务规则等承重限制保留。本次不修改任何 AGENTS.md；具体实施需列出发生冲突的规则及依据，不静默扩大路径权限。

### 精确交接合同

- **Practice**：真实 host 为 `server/start/routes/practice.tsx`，已有 `PracticeClient` 方法注入；视觉保持既有 issuance、response draft、submit、judge status、hint/solve 等调用及错误语义。不因方法叫 get/read 就认定无写入、无 queue 或无 paid；是否触发效果由完整操作 owner 判定。
- **Library**：保留 `LibraryClient` 的 question/draft reader、知识选项的零参数 `() => startWorkbenchClient.getTree()` 适配；query key、分页、过滤、计数未知、partial、错误与失效保持。`MyHistory.tsx` 是展示与 query 接缝共享节点，不整文件冻结。
  YUK-1358 [当前精确片记录](https://linear.app/yukoval-studios/issue/YUK-1358#comment-26f4d6df-47a2-47b9-92b0-4fa58d778cdd)为 #2086 的 id-only mistakes reader，由 #2086 合入 `629fb1a1`，已包含在本次基线；UI 保留其 client/host/调用合同，不借视觉改造重写查询或错误恢复。
- **Companion**：壳经 `copilot/ui-public.ts` 消费唯一 `CompanionMount`。关闭/卸载读取与显式 Stop 是不同动作；保留接受回执、未知发送恢复、session/run identity、只断订阅不暗中取消、重开/刷新及状态重读。视觉不得自建恢复 owner、重发未知 turn 或把流文本当持久提交。
- **Ingestion**：保留原上传、识别、agent、手工录入、classic 显式复核、当时/现在与历史缺证据语义；恢复键/重试键沿用 owner，识别和 paid 操作保持显式触发。没有历史接口时呈现未接通，不能画成空状态遮掉。
- **共享文件**：`RootShell`、各 `ui-public.ts`、`server/start/routes/*`、生成 route tree、公共 client 类型需逐 hunk 协调。UI writer 交实际组件/props；transport writer 交已批 client/route 注入。只有真正重叠的 hunk 等交接，不锁整条线，不另造空转发层绕开 owner。
- **回退与退出**：尽量沿用同一路由/同数据合同的渲染回退；样式回退不回滚业务数据、不重放命令。没有 live consumer 不建开关；既有旧组件移除要求仍按原票证据，不以一周无人访问算通过，也不复活已删页面。

## 6. 验收层次与运行权限

| 层次 | 能证明什么 | 不能代替什么 |
| --- | --- | --- |
| 本次文档静态 | 五路径范围、固定 base/diff、历史保留、链接与交接一致；Google 获取范围如 §3 | 文档检查不证明 UI、测试、浏览器、接口或 provider 的实际行为 |
| 后续产品源码静态 | token/组件角色、调用方接缝、状态映射、无新增 `useEffect`、不引入业务/恢复重复 owner | 不能证明视觉、交互、可访问性或真实写入成功 |
| 后续本机检查 / CI | 按当片范围记录 typecheck/lint/build、独立 review、exact-head CI 的实际结果；测试代码先获 owner 批准，测试不作开发前置 | build/CI 不等于已部署，不等于真实页面/写恢复/provider 通过；当片执行情况以其 PR 的真实记录为准 |
| 真实页面 | 在真实现役入口展示实际输入/输出、选择依据、桌面/窄屏、亮暗、键盘/focus、reduced-motion、读屏与全部可达状态，保留 screenshot/录屏/对照 | 不新建演示入口；fixture、设计稿或未发生的状态不能标成真实业务验收 |
| 写入 / 恢复 / provider | 逐真实样本记录初始状态、命令/回执、重开后的已提交状态、明确停止阶段、错误与未知结果；模型输出另记 exact revision、task-run、provider/model/cost 与输入输出 digest | 不用发送成功、只读重开、模拟流或旧 CI 证明持久性、停止效果或学习质量 |

后续运行沿用原票已经授予的环境、操作与预算，不增加例行确认。只有缺少实际环境/样本/预算或范围发生变化时，才集中提出精确缺项；**本轮无任何运行权限扩张**：

1. 题库写验收先给自有样本 ID、原状态、canonical 删除/恢复边界和可逆处置；不使用未知真实学习题。原只读许可不授权编辑、审核、删除/恢复。
2. 录入上传/识别/history 全链先确认目标后端确实接通及样本/写入/paid 范围；缺接口不为验收擅自部署。读取也按完整操作判断副作用，不能按 HTTP 方法猜。
3. 伙伴不能重用旧“两 turn”安排当作自动续期额度。需确认自有会话、实际可用预算、运行上限、当前 provider；unknown 请求不盲重试，Stop 必须确实处在正文流出阶段才能记该项通过。
4. 既有费用纪律和原票预算不因视觉计划自动扩大；未知费用保留未知。TEST 用途不转日用，容器/DB/部署沿用各自原授权与锁，不由视觉计划派生。
5. 后续真实证据外置到 `tlp-audit-artifacts/<原票>/<实际head>/`，git 只留结果、命令、revision、外部位置与实际生成的摘要；本轮不手算 SHA/seal，不伪造证据回执。

## 7. 本次交接与未决项

本次只改当前入口、旧方向顶部、迁移顺序、准备计划当前入口/模型及 charter 的 UI 覆盖，由协调线按文档 PR 流程收口。
计划合入仅代表方向与排期生效，不代表 UI 实现、部署或运行验收完成；产品与测试代码均不在本次变更内。

**无新的风格或产品决定待 owner 重选。** 尚需补齐的是组件具体 Specs（含数值、状态、Web availability）的可获取证据、各实施片真实修改 hunk 与原票运行许可条件，
不是本方向待批准。若未来官方规范与现存业务功能发生实质冲突，先给协调线精确冲突和最小保功能方案，不静默降级确定性能力。
方向与未完验收继续由 YUK-1351/YUK-1473、transport 由 YUK-1358 承接，不因计划合入将原票整体标为完成。
