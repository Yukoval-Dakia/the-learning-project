# 2026-06-13 全站视觉对照审计（visual gap）

> 三段式审计的合成产物：
> **Phase A** 基础层对账 → `.omc/research/2026-06-13-visual-audit-foundation.md`
> **Phase B** 全路由截图 → 仓库根 `.playwright-mcp/va-01 ~ va-11.png`（1440×900 fullPage）
> **Phase C** 10 路逐页对照 fan-out → Workflow `wf_6b7265ec-223`（10 agents / ~1.14M subagent tokens / 302 tool uses）
>
> 设计真理源：`docs/design/loom-refresh/project/`（loom.css / tokens.css / 各 screen-\*.jsx + 配套 css）。
> 每页 agent 输入：截图 + 设计源 + 实现侧组件/CSS + Phase A 报告 + 升级后标准（逐 token / 逐布局 / 显式审美自评）。
> 重绘范围建议见 §5，**决策权在 owner**。

---

## 0. 总评

10 页共 **93 条页面级 gap：25 HIGH / 36 MED / 32 LOW**，另有基础层（全局）条目 6 项（含 1 项 Phase C 新发现、1 组 Phase A 论断修正降级）。

| 页面 | 截图 | 气质评分 | 一句话判语 |
|---|---|---|---|
| 全局 chrome / 根壳 | va-10/11 | **3** | 内容 7 / chrome 0：SPA 根壳零导航骨架，⌘K palette 实现侧不存在 |
| /today | va-01 | **6.5** | 骨架同构；热力图 CSS 整段缺失致页尾失形，右缘双空位失重 |
| Copilot dock 展开态 | va-02 | **2** | Tailwind utilities 断供，抽屉 chrome 整体不渲染，内容裸摊文档流 |
| /inbox | va-03 | **6** | 卡内五段结构忠实；页头+lane 标题 chrome 全线裸奔，块合并卡裸 ID 文本墙 |
| /agent-notes | va-04 | **6.5** | an-\* 移植近乎逐行忠实；page-head chrome 零样式 + 无壳孤悬 |
| /record | va-05 | **3** | 形态不同构（单列长问卷 vs 紧凑双列）+ utilities 断供致 CTA/卡片视觉消失 |
| /practice（pface 流） | va-06 | **6** | 流骨架还原度高；卡内信息层级砍平，13 张卡均质化 |
| /knowledge | va-07 | **6**（树 8 / 图 4） | 树视图气质达标；图谱丢掌握度环/typed 边色/图例，读作线框稿 |
| /knowledge/$id | va-08 | **6** | 上半屏骨架对位；时间线 30 条无界直出右坠失衡，邻居卡缺「层级」块 |
| /notes/$id | va-09 | **4**（截图态 3） | 空态退化为裸灰字读作故障；正文层缺 display 标题/入口 strip/Notion 化读态 |

**结构性结论**：实现侧的**移植完成度显著高于消费率**——大量与设计对位的 CSS/primitives 已经躺在仓库里（loom .drawer 套件、EmptyState/Stateful/SkLines、入口 strip CSS、.back-link、点阵画布底），但组件没接上；同时三类机制性断点（Tailwind utilities 断供、scoped chrome port 漏页、legacy 双定义压制）把多数页面的「头脸和画框」打掉了。**骨架的诗意大多在，细节的锚点和样式管道断了**——这意味着相当一部分 HIGH gap 的修复物料已存在，成本远低于全量重绘。

---

## 1. 基础层（全局）

### F0【新发现 · Phase C 补报】SPA Tailwind utilities 断供 —— 样式系统级断供，建议无条件立即修

- **证据（硬）**：`curl :5173` 实测 SPA 编译产物 CSS（251KB）中 `@layer utilities;` 为**空层**，`.fixed` / `w-[420px]` / `text-[13px]` 等 arbitrary utilities 0 命中；class-based 规则（.copilot-loom/.chip/.badge）正常生效。dock 与 record 两个 agent 独立确证。
- **根因**：`web/vite.config.ts:9-11` —— Vite root=`web/`，`@tailwindcss/vite` 的源扫描不含 `../src` `../app`；`app/globals.css:3` 的 `@import "tailwindcss"` 没有任何 `@source` 指令。
- **受灾面**：所有依赖 Tailwind utilities 的组件在 SPA 内整体裸奔——
  - `src/ui/primitives/CopilotDrawer.tsx:74-101`：抽屉 chrome（fixed 定位/460px 宽/scrim/阴影）100% utilities → dock 完全失去形态（dock 评分 2/10 的主因）；
  - `src/ui/primitives/Button.tsx` / `Card.tsx`：record 页 primary CTA「提交 → /mistakes」渲染成裸灰字、卡片边框/圆角/内衬蒸发、「设置」按钮图标文字竖排（record 评分 3/10 的主因之一）；
  - `CopilotDock.tsx:573-616` summary 槽、inbox/practice 页底裸「召唤 Copilot」trigger 同源。
- **修法二选一**：① `app/globals.css` 加 `@source "../src"; @source "../app";`；② 把受影响组件切到 globals.css **已移植完毕但无人使用**的 class-based loom 类（.drawer 套件在 `globals.css:6264-6308`）。方案 ② 同时消解「双轨维护」问题（见 P4）。
- **定性**：客观 bug，与重绘范围决策无关。Phase A 只审了 globals.css 源码、未审编译产物，故漏报；本条为 Phase C 升级补报。

### F1 `.page` 容器 legacy 硬编码（Phase A #1，维持）

`globals.css:617-624`：`.page` max-width 880px / `.page.wide` 1140px，padding 36/28/56 —— 设计为 `--cap-wide` 1200 / `--cap-app` 960，padding 32/24/64。全站影响分布不均：

- **最重**：/agent-notes 命中裸 880（比设计窄 27%，叠加无侧栏后整页「窄、飘」）；/notes/$id 被 `.page.wide` 双重包裹，挤压 reader 自带的 cap-wide/padding 布局系统（topbar 内缩、双重内缩 ~52px，HIGH）。
- **反向违例**：/record 设计点名 `cap-app` 960（tokens.css:154 注释），实现却挂 `.page.wide` 1140，宽 19%，加剧长问卷感。
- **较轻**：today/inbox/knowledge/kd 走 `.page.wide`，收窄量缓解到 -60px。

### F2 【论断修正 · 降级】refine.css gating 策略差异（原 Phase A #2 阴影三层、#3 coral glow 及 chrome 漂移组）

today agent 逐字核对 `refine.css:16-107`：阴影三层、card 边框 line-soft、hero flat、btn-primary coral glow、section-label s-8 节奏、eyebrow 0.06em、kpi-val -0.02em **全部包含在设计自带的 `[data-refine=on]` gated 精修层内**。实现侧的实质是「把设计自带的 gated 层提升为默认」，而非 Phase A 判定的 YUK-297 基准外漂移。

- **处置**：这一组从 gap 清单移出，降级为「gating 策略差异」。**补充（2026-06-13 合成后核 Linear）**：YUK-297 issue body 已记录 owner 2026-06-08 拍板「全局精修直接设默认样式（不做 data-refine 开关）」——即「提升为默认」本身就是在执行 owner 决断，非实现侧自作主张；决策点 ① 视为已决（默认全开），除非 owner 主动翻案。
- **保留的例外**：today 页 strip 分隔线 `line-soft`（globals.css:8262）超出 refine 授权范围（refine 只授权 card 外框），仍计 LOW。
- 各页 FOUNDATION_IMPACTS 中标注的「阴影更浮 / CTA 更亮」可见度记录保留，作为 gating 裁决时的参考材料。

### F3 section-label 双定义冲突（Phase A #4，维持 + 页面级修复缺口）

`globals.css:1273` legacy 垂直 block 定义 vs 设计 `loom.css:240-243`（flex row + serif h2 22px + 横向 rule 线 + count 右置）。命中时表现为：28px 秃标（被全局 h2 规则接管）、无 rule 线、count 折行成孤行。

- **已 scoped 修复**：today-loom（globals:8057）、items-loom（:10339）等。
- **未修复（本轮实证）**：/inbox（4 个 lane 标题全中，count "3"/"9" 折行）、/agent-notes（「更早」组）、/knowledge/$id（5 个分区标题全中，「标注笔记」「邻居」几乎贴上文）。

### F4 info 色三轨（Phase A #5，维持）

`--info-line` 等 token 为实现自补、未回写设计源（globals.css:262）。各页消费均走 token 路（inbox shell.css、agent-notes、kd），当前视觉无恙；风险是设计侧将来补值不同会整体漂移。处置：回写设计源或在设计稿登记该 token。

### F5 font-size 红线违例（Phase A 附加项，维持 + 归因细化）

约 200 处硬编码（11px×75 + 12px×31），违反 tokens.css:96「nothing < 13px ever ships」红线 122 次。Phase C 归因细化为两类：

- **设计稿自身违例**（需先在设计侧裁决，不算实现漂移）：agent-notes an-sig 11px / an-new 10px（agentnotes.css:105,109）、kd verify-badge/rel-kind 11px（p5.css:57,97 / screens-2b.css:97,122）、inbox kind-tag 11px（screens.css:294,297）。
- **实现侧违例集中区**：dock（msg-name 11px、chat-thinking 12px、summary 槽 11.5–12.5px 四级小字）、note-reader（10px×3：nb-sem-tag/nb-qref-tag/slash-key）、practice shelf/retro 视图（10/11px + 一处 56px）。

### F6 其它 Phase A 附加项

- brand-sub 文案漂移（「织 · 学习编织台」vs 设计「织·学习系统」）——仅旧 Next 壳可见。
- **勘误**：Phase A 记录的 brand-mark 30px/stroke 1.7 微漂移，对照更新版壳真理源 `app.jsx:122`（BrandMark size=32）实现其实是**对齐的**——Phase A 以旧 shell.jsx 为基准误报，撤销。

---

## 2. 跨页重复模式（页面层主线）

### P1 loom 页头 chrome「按页 scoped 移植」的漏页 —— 最高频、最低成本的修复模式

机制：.eyebrow / .page-lead / .section-label / .seg 等 loom chrome 词汇在 globals.css 是**按页 scoped** 移植的（.today-loom :7896 / .knowledge-loom :7603 / coach :9580 / sessions :9889 / events :10126 / items :10305）。漏 port 的页面整段 chrome 裸奔：

| 页 | 缺口 | 实证表现 |
|---|---|---|
| /inbox（.inbox-loom） | eyebrow + page-lead + section-label 全缺 | 页首三段塌成同色近同号正文；4 个 lane 标题 28px 秃标 + count 折行 |
| /agent-notes（.agentnotes-loom，globals 零命中） | eyebrow + page-lead 缺 | 13px mono 刻字退化为 15px 深色正文，页首「展卷」感消失 |
| /practice（pface） | eyebrow 缺 + seg 碎裂 | eyebrow 与正文同重；视图切换控件落 legacy .seg → 图标文字分行堆叠、无 pill 容器无选中态 |
| /notes/$id | .page-title 仅有 scoped 定义 | h1 回落基础 36px（设计 fs-display 48px） |

修法：每页补一段 scoped 规则即愈；或一次性把这组 chrome 升为全局非 scoped 定义（前提：清理 legacy 同名类，见 F3）。

### P2 卡内信息层级被砍平

- practice 散题卡缺 pf-item-kp 知识点标题（15px/600 锚点）、卷卡缺 serif 19px 标题 + 「N 题 · 约 X 分钟」facts 行 → 13 张卡退化成「badge + 灰字 + 按钮」均质重复；
- inbox 卡头排无 title 锚点（预批偏差，但视觉代价实证：两枚小 chip 后 ~800px 空白，16 卡扫读无差异）；
- today SessionsStrip title/sub 同读「已复习 N 题」，一行信息重复两遍。

效果：设计稿「每张卡有自己的名字」的叙事没接住，扫读失锚。

### P3 raw ID / 机械文案取代设计的 readable evidence

设计首则注释「Readable evidence (no raw IDs up front)」在三处失守：

- inbox 块合并卡 reason_md 直渲，9/16 卡正文充满 `block-xq9zJ2…` 长 ID 文本墙；evidence chips 同卡 3 枚同文案灰 disabled 胶囊；
- kd 活动时间线 30 行 "user · question · success" 三连元数据（设计是 "答成『代词』" 式人话 note），debug-log 化；
- practice ref_id `slice(0,12)` 产生「question · synthetic:q:」悬挂冒号残串；开场 meta 丢 agent/时刻/成本 evidence 形态。

这一组直接对撞项目「evidence-first 可读留痕」的产品气质，是「温暖可读 → 日志 dump」滑坡的主力。

### P4 已移植却闲置的死代码 —— 修复物料已在仓库里

| 已移植资产 | 位置 | 弃用方 |
|---|---|---|
| loom .drawer 套件 | globals.css:6264-6308 | CopilotDrawer 用平行 Tailwind 实现（双轨维护 + 断供受灾） |
| Stateful / EmptyState / SkLines | src/ui/primitives/ | note-reader 空态用裸 quiet-empty 一行字 |
| 入口 strip CSS（note-entries/entry-pill） | globals.css:6687-6760 | NoteReaderPage 未渲染入口 strip（HIGH） |
| .back-link | globals.css:7135-7151 | kd / note-reader 用 Btn ghost 代替 |
| 点阵画布底 .kg-svg-stage | globals.css:3650-3661 | 新 MeshGraph 未复用，画布纯白双框 |
| WeekHeat 全段 CSS | globals.css:8230-8234 **显式 OMITTED** | 豁免理由「端点未迁」已过期（/api/workbench/summary week_heat 已 ship，TodayPage L205 已接线），组件渲裸 DOM |

---

## 3. 页面层（逐页）

> 完整 gap 明细（severity + design 行号 + impl 行号 + detail）见 Phase C 原始 findings；本节收录 HIGH 全量 + MED 要点。

### 3.1 全局 chrome / 根壳（va-10/11）—— 3/10

设计是 sidebar-primary 五件套（240px paper-sunk 左 rail + sticky topbar(crumbs/searchbox/⌘K) + mobile tabbar + CommandPalette + CopilotDrawer，app.jsx:116-204）；实现 SPA 根壳（`web/src/router.tsx:25-34` RootShell）只有 `<Outlet/> + <CopilotDock/>`。

- **[HIGH] SPA 根壳零 chrome**：/ → /today 落点无 rail、无 crumbs、无搜索、无 tabbar；内容带孤悬 1440 宽纸面，左右各 ~180px 无结构空白。已对齐设计的 chrome 组件存在于 `src/ui/shell/*` 但只挂旧 Next 壳整理区残页——用户第一眼永远看不到。M4/M5 迁移已知中间态（layout.tsx:109-112 注释在案），但「SPA 收编 chrome」须列重绘最高优先级。
- **[HIGH] ⌘K CommandPalette 实现侧不存在**（专查结论）：全仓 grep `CommandPalette|cmdk` 0 命中，组件/CSS/keydown 三者全缺。旧壳 topbar 的 searchbox 是 `aria-hidden` 纯视觉占位、⌘K kbd 是不可兑现的可见承诺（比不渲染更伤可信度）。
- **[MED] Copilot 唯一入口 = 文档流末尾裸 legacy quiet Button**（无定位，要滚到页底才能召唤；设计是侧栏脚 + topbar 双 chrome 入口）。
- **[MED] admin 独立壳概念差**：设计显式裁决「admin is a separate shell — no main app chrome」（app.jsx:106-114）。当前实现恰好也是独立壳（方向一致），但 M5 t6 将 admin 平移为 SPA 普通路由——**SPA 将来收编主 chrome 时，admin 套不套主 chrome 必须显式拍板，不能默认跟随**（见 §5 决策点 ③）。
- LOW：旧壳 nav 收缩为 3 项迁移残体（设计 9 项 + count 徽章）；brand 点击回退目标漂到 /mistakes（迁移期权宜，收编后应恢复 /today）。

### 3.2 /today（va-01）—— 6.5/10

骨架完整（hero → kpi → 今日之线 → dash-grid → AgentNotesBoard → 本周编织），双列配重对。

- **[HIGH] WeekHeat 热力图 CSS 整段缺失**：.week-heat/.heat-row/.heat-cell/.heat-axis 零定义（OMITTED 豁免已过期，见 P4），7 列 coral 热力网格坍缩成一行挤压的星期字——设计里这是全页 coral 叙事的收束高潮，现在以无样式碎片收尾。
- **[HIGH] KPI 4 列网格只放 3 卡**：「AI 提议·待审」卡缺位（数据就在同一 summary 响应里），第 4 列恒空；16 条待审提议这一最高优先级信号从 KPI 层缺席。
- **[MED] 设计外整页琥珀 wash**：legacy `.today-page::before`（globals:3307-3335）三重径向渐变命中 SPA 根类，上半屏图底关系与设计 warm-paper-上浮卡片相反。
- MED：今日之线 3 列恒空第三列（夜链交班缕待 M5 task_run 读模型，但 grid 未随容量收窄）；SessionsStrip 文案重复 + completed 会话与活跃等权。
- 右缘失重（KPI 第 4 列 + threads 第 3 列双空位）+ coral 叙事断尾（hero CTA → 提议卡 → 热力图第三站熄灭）是本页气质三大伤。

### 3.3 Copilot dock 展开态（va-02）—— 2/10

- **[HIGH] utilities 断供 → 抽屉 chrome 整体不渲染**（= F0，dock 是全应用最依赖 utilities 的面，受灾最重）：无定位、无宽度、无 scrim、无阴影，dock 内容全宽裸摊文档流末尾。
- **[HIGH] 弃用已移植 .drawer 套件，抽屉头解剖全非**：设计 19px serif 标题 + coral 图标 + 在线 badge + maximize/teach/close 三 IconBtn；实现 14px sans + 唯一「收起」文字按钮，全屏与教学模式入口缺失。
- **[MED]×4**：尺寸/留白全面收紧（420 vs 460px、消息间距 8 vs 16px、硬编码 px 绕过 --s-\* token）；对话改写为 IM 风盒装气泡（设计是无框「安静手稿」平文）；**dwell 策略——回访用户每次整页加载自动弹开 + scrim + body 滚动锁**（use-copilot-dwell.ts:5-11，Wave 5 有意行为但与设计克制姿态相悖，建议 surface 重判，见 §5 决策点 ②）；composer 裸 textarea + 外挂按钮 vs 设计一体化胶囊。
- LOW：scrim 冷黑字面量绕过暖墨 --scrim token；tool_use 卡 phase-deferred（注释合规）；summary 槽四级 11.5-13px 小字（红线违例密集区）。
- 另：🔴🟡 emoji 大标题属 agent 输出风格层，设计语言用 FSRS 三色 token 表达紧急度，建议与 UI 一并治理。

### 3.4 /inbox（va-03）—— 6/10

lane 顺序、卡内五段结构、summary+筛选卡忠实复刻，骨架没走形。

- **[HIGH] .inbox-loom 缺页头 chrome scoped port**（= P1）：eyebrow/page-lead 裸渲 15px 正文，开场即失神。
- **[HIGH] .inbox-loom 缺 section-label scoped port**（= F3 本页实例）：4 个 lane 标题 28px 秃标、无 rule、count 折行孤行——sibling 六页都补了，唯独 inbox 没补。
- **[MED] 块合并卡裸 raw block-ID 文本墙**（= P3，9/16 卡）；evidence chips 同卡多枚同文案灰 disabled；proposal-head 无 title 锚点（预批偏差，视觉代价记录在案）。
- 骨架 8 分、皮肤 6 分、内容可读性 4 分。

### 3.5 /agent-notes（va-04）—— 6.5/10

an-\* CSS 近乎逐行忠实移植，左 rail 串线 + 信号 chip 右对齐 + mono meta 灰阶递进与设计同性格。

- **[HIGH] 全局壳层缺席**（M5 已知状态，记录形态差）：880px 内容柱孤悬，两侧各 ~280px 空纸。
- **[HIGH] page-head chrome 未移植**（= P1）：.agentnotes-loom 在 globals.css 零命中，eyebrow/lead 同为 ~15px 深色 sans，页首三级落差（13px mono → 36px serif → 17px 引言）塌掉。
- LOW×3：an-evi 灰色静态降级变体（合理工程扩展，未回写设计）；eyebrow 文案漂移；日分组「前天」→「更早」（合理泛化）。
- 红线违例（an-sig 11px / an-new 10px）源头在设计稿自身（F5）。

### 3.6 /record（va-05）—— 3/10

**形态不同构**：设计是紧凑双列工作卡（960px、form-2col、composer 2 行、coral 两点点睛）；实现是 1140px 单列长问卷（三个 5/3/3 行大 textarea 全宽堆叠，~900px 高）。

- **[HIGH] legacy Button utilities 未编译**（= F0）：唯一 primary CTA「提交 → /mistakes」裸灰字，视觉权重 ≈ 0；「设置」按钮图标文字竖排。
- **[HIGH] legacy Card chrome 整体缺失**（= F0）：边框/圆角/内衬蒸发，表单与背景失去 figure/ground 关系。
- **[HIGH] 单列长问卷 vs 设计紧凑双列**（form-2col + 38px field-input + composer rows=2）。
- **[MED]×6**：页宽 1140 vs 设计点名 cap-app 960（F1 反向违例）；原生滑杆深黑轨道成全页最重墨块（设计 6px paper-sunk 轨 + coral thumb + 刻度）；chips 胶囊化 + 无 check 图标 + 选中边框 --coral 强一档；AI 复审区从常驻面板降级为第 4 个 tab（信息架构变化）；题面输入未用 composer 形制（r-2 + serif + 无 focus 态）；错答字段丢 again 红色语义。
- 动作层级倒挂：本应最重的 CTA 视觉为零，本应最轻的滑杆右半截深黑反而最重。

### 3.7 /practice（va-06，pface 流形态）—— 6/10

织线纵轨 + 节点 + 卡片挂线 + AI 开场白 + 流尾 composer 全在位，§6.1 骨架还原度高。

- **[HIGH] 页头 seg 视图切换碎裂**（= P1）：落 legacy .seg，图标文字分行、无 pill 容器无选中态；knowledge/coach 都做了 scoped 移植，pface 漏了。
- **[HIGH] 散题卡缺 pf-item-kp 知识点标题**（= P2）：13 张卡均质化成灰条重复，本页与设计气质差距最大单点。
- **[HIGH] 卷卡缺 serif 标题 + facts 行**（= P2）：摞纸边缘还在，但无内容支撑，「一摞纸」读不出来。
- MED：eyebrow 裸渲（= P1）；ref_id 截 12 字符悬挂冒号（= P3）；done 织入行缺 verdict 三色 badge + 完成时间（color-is-judgment 在织入行丢失，代码对照确认）；allDone 收尾卡 pf-close 未实现。
- LOW：AI 增补/点播视觉链 M4 phase-deferred（注释合规）；设计外「按当前信号重排」按钮挪用 .pf-item-cta；开场 meta 丢 evidence 形态。

### 3.8 /knowledge（va-07）—— 6/10（树 8 / 图 4）

树视图是本轮审计少见的「气质达标」实现（serif/mono 对比、树行节奏、环-chip-badge 信息梯度全对）。图谱视图骨架方向一致（#363 裁决的 tidyTree 层级散布），但执行层大失血：

- **[HIGH] 图谱节点丢掌握度环**：设计 = tone 圆盘 + feDropShadow + paper-raised 满轨 + 3.5px 圆头掌握度弧 + hub r24/普通 r18 分级；实现（MeshGraph.tsx:116-126）= r16 均一淡圆 + 数字。树/图共用的「掌握度环」视觉语言在图谱侧断裂。
- **[HIGH] mesh-controls（zoom ±/百分比/复位）与 mesh-legend（5 类关系图例）整体缺席**：只剩一行 key-hints 文字；图例缺席使 typed 边失去解码钥匙。
- **[HIGH] typed 边编码塌缩**：5 类关系色（coral/ink-4/info/good/hard）全失，统一 ink-5 1.4px 75% 透明；中点文字标签丢失只剩 11px glyph。「mesh 是 5 类 typed 关系」核心叙事在图上失效。
- **[MED]×6**：画布缺点阵纸纹 + 双层边框嵌套（.kg-svg-stage 点阵底已移植未复用，= P4）；**双阈值矛盾**——mastery-tone.ts 0.7/0.4 vs NodeDrawer.tsx 0.67/0.45（设计统一 67/45），43% 节点环黄 badge 红自相矛盾；贫深度树被 rowGap 满幅拉伸公式（layout.ts:264）劈出 ~380px 垂直空洞（建议加 ~115-150px 上限）；AI 提议横幅丢 sunk 变体；树行错题 badge 未实现（wire 类型无 mistakes 字段）；**图谱选中态失效**——inline stroke presentation attribute 被 knowledge.css 类规则永久压制（抽屉开着但图上看不出选中谁，代码级确证）。
- know-title 用 MiSans 是 owner 钦点（globals.css:7686 留痕），但与图谱节点标签 wenyan serif 跨视图不一致，列 §5 决策点 ④。

### 3.9 /knowledge/$id（va-08）—— 6/10

上半屏骨架对位（页头环+serif 标题+meta、kd-grid 1fr/340px 双栏）。

- **[HIGH] 邻居卡「层级」块整体缺失**：parent 降级为页头内联下划线文字链（非 design-system 模式），children 在 API（node-page.ts 只返回 parent_id/parent_name）和 UI 都无渲染路径——信息架构偏离，已确认是实现缺失而非贫数据。
- **[HIGH] 活动时间线无界直出 30 条**：无 max-height/折叠/查看更多，kd-side 高度 ≈ 主列 2.2×，页面下部 2/3 成「左空白 + 右长尾」失衡；富数据只会更糟。
- **[MED]×4**：event 行机械文案（= P3）；eyebrow 定位行缺失（CSS 已移植本页未消费）；section-label 缺 scoped override（= F3，5 个分区标题全中且姊妹页已补）；decay pill 语义从 R（可提取性）换成 M（掌握度）与环值同屏重复，丢衰减维度。
- LOW：错题 Badge 缺（API 无 mistake count）；页头规格缩水（环 64→56 等）；rel-row 双箭头连排丢 chip-k 节点 tag；.back-link 已移植未消费（= P4）。

### 3.10 /notes/$id（va-09，截图为 not-found 态）—— 4/10（截图态 3，正文代码级推断 5-6）

- **[HIGH] 空态/加载态弃用 Stateful/EmptyState/SkLines，退化为裸 quiet-empty 一行字**（截图实证，= P4）：14px 灰字悬在空页左上，无图形锚点、无标题层级，页面读作「故障」而非「空态」。三个 primitives 实现侧都存在却未用。
- **[HIGH] .page.wide 双重包裹挤压 reader 自有布局**（= F1）：max-width 压 1140、双重内缩 ~52px、sticky topbar 内缩读不成贯穿 sub-bar。
- **[HIGH] 入口 strip + 入口 banner 整体缺失**：「一篇笔记多扇门」的核心视觉表达（entry-pill is-here coral 反白 + coral banner）完全未渲染，入口上下文 param 未实现；对应 CSS 已移植成死代码（= P4）。
- **[HIGH] 读态正文失 Notion 化结构与 prose 尺度**：无 .note-reader-body wrapper → 正文落 15px（设计 fs-body-lg 17px）；无 28px gutter/锚点/节折叠；crossLink 渲 inline 小 pill 而非整宽 BlockLinkCard。阅读柱从「文档阅读器」降为「字段列表」。
- **[MED]×4**：标题 36px 而非 48px display + eyebrow/label chips 缺（= P1 同根因）；两侧 rail 缺 wrapper → sticky 失效 + 响应式断点落空（窄视口三栏直接挤坏）；topbar 缺右栏 toggle 与移动端 drawers；编辑态缺 .note-edit-shell 虚线容器 + gutter 64 vs 44px。
- ⚠️ 正文层全部为**代码级推断**——dev 库无 note artifact，见 §4 补拍清单。

---

## 4. 数据 caveats 与补拍清单

贫数据是本轮审计的系统性限制（knowledge 7 节点 / artifact 9 / question 15），以下形态未经像素验证，重绘验收时必须用富数据复测：

| 页 | 未验证面 | 所需数据/动作 |
|---|---|---|
| /notes/$id | **正文渲染零覆盖**（仅 not-found 态入镜）：三栏 sticky、双重内缩、48px 标题、入口 strip、大纲噪声、编辑态 | 补种 note（≥3 label + crossLink + questionRef + pitfall/example 语义块 + AI 修订记录）后**补拍 va-09** |
| dock | tool_use 卡（route 不回传）、CopilotHeroCard（无 primary_view）、ask_check 题卡——设计三个重头戏组件零渲染 | 待后端回传 + 教学会话数据 |
| /inbox | 截图疑似无 shell 挂载（1440 内居中、底部裸 trigger）；conf-bar/cost 15/16 卡空；resolved 留痕、改关系 seg 展开条 | 带 shell 重截 + 含 confidence/cost/已裁决数据 |
| 全局 chrome | 旧 Next 壳侧栏/topbar **零截图覆盖**（两张输入截图 MD5 相同，全部判断基于代码静读）；rail-collapsed/dark/mobile 三态未覆盖 | 旧壳路由补截（若旧壳存续期内还需要） |
| /knowledge | fcose 分支（>60 节点）、5 类 typed 边混排、长名截断、hot 行底色 | 富图谱数据 |
| /knowledge/$id | kd-primary-note 整篇阅读体 / 反向链接分组 / 多类 rel-tag——主栏最重设计资产未验证 | 同 note 补种 |
| /today | threads 三缕齐满、17 kind 混排、热力五档渐变（修 CSS 后） | 富活动数据 |
| /practice | done 织入行 verdict 三色、skipped 段、in_progress 草稿、卷 facts | 多状态流数据 |
| /agent-notes | unread 视觉链（an-new pill / coral 角点 / 全部已读按钮）、多日分组节奏、TTL 临期态 | 未读+多日信号 |
| /record | 拍单题/拍试卷/AI 录入三个 tab 零覆盖；50 chips 满载态 | tab 遍历补截 |

⚠️ 约束：**不往 dev 真相源 Postgres 灌假数据**。补种 note 等测试数据须经 owner 授权路径（专用 seed + 用完即删，沿用此前惯例）。

---

## 5. 重绘范围建议（owner 决策）

三档方案 + 四个独立决策点。方案为递进关系（乙含甲、丙含乙）。

### 方案甲 —— 机制修复（不算重绘，建议无条件做）

1. **F0 utilities 断供**：globals.css 加 `@source`，或受灾组件切已移植 class-based 类（dock 建议直接切 .drawer 套件，顺手消双轨）；
2. **P1 scoped chrome 三页补 port**（inbox / agentnotes / pface，每页一小段 CSS）+ note-reader page-title；
3. **WeekHeat OMITTED 解禁**（豁免理由已过期）+ KPI 第 4 卡（数据已在响应里）；
4. note-reader 空态接 EmptyState/SkLines（primitives 现成）；
5. knowledge 双阈值统一（67/45）+ 选中态 stroke 压制修复 + rowGap 上限。

预期效果：dock 2→5+、record 3→4、inbox 6→7、today 6.5→7.5；纯接线/补段工作，无设计决策依赖。

### 方案乙 —— 页面级补齐（中度）

甲 + P2/P3 全量（practice 卡标题/facts、inbox readable evidence + title 锚点、kd 时间线收敛+叙事 note、ref_id 可读化）+ knowledge 图谱材质三层（掌握度环/投影/typed 边色+图例+点阵底）+ kd 邻居「层级」块（含 API 补 children）+ record 双列表单重排 + note-reader 入口 strip/读态结构。

### 方案丙 —— 完整重绘（按 claude design 分工）

乙 + **SPA 收编全局 chrome**（侧栏/topbar/⌘K CommandPalette 从零建/tabbar——与 M5 Task 6/7 收编节奏衔接）+ dock 对话语言回手稿形态 + 设计源红线违例回写（F5 设计稿自身违例部分）+ --info-line 等自补 token 回写设计源。按既定分工：claude.ai/design 出视觉稿 → 功能 handoff → slice-by-slice 实现。

### 独立决策点（不依附任一方案，需逐项拍板）

1. **refine 层 gating**：实现现状=默认全开；设计=`[data-refine=on]` gated。**已决**——YUK-297 记录 owner 2026-06-08 拍板「全局精修直接设默认样式（不做开关）」，现状即 owner 决断；除非翻案，无需再拍。（F2）
2. **dock dwell 自动弹开**：回访每次整页加载自动弹开 + scrim + 滚动锁（Wave 5 有意行为），与设计克制姿态相悖。维持 or 改为主动召唤？
3. **admin 壳形态**：设计裁决 admin 独立壳无主 chrome；M5 t6 平移为 SPA 普通路由后、SPA 收编主 chrome 时套不套？**须在 chrome 收编前拍板**。
4. **跨视图字体**：know-title MiSans（owner 钦点）vs 图谱节点标签 wenyan serif，是否统一。

---

*审计执行：Phase C Workflow `wf_6b7265ec-223`，10 agents，1,135,051 subagent tokens，302 tool uses。原始逐页 findings 含全部 design/impl 行号引用，本报告为编辑合成（含 Phase A 论断修正与升级补报）。*
