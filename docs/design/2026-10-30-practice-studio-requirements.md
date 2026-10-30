# 做题工作区：需求驱动的完整呈现重建

原 YUK-1473 / YUK-1351。2026-10-30 owner 新明确方向。原2196及fb1948候选均未获本次验收；旧报告/源码保留，不追加旧diff第三审。
基线 freshmain `06b4e6bc8097282130fc7b0e522a9cb6bdb4c1dd`，父唯一writer，新父树 `tlp-ui-practice-studio-20261030`。原ui-day-one-usable的now.md与counts-before.txt保持；运行旧候选fb1948树clean，5174 PID65562，尚未切换。

## 必须解决的任务与信息架构

1. 学习者从实际全局目的地进入练习：今日、练习、录入、题目库、收件箱及原其余目的地必须可达；路由身份与导航权限仍由原NAV投影，不能手造新路由表。桌面常驻带标签rail，手机压为底部核心目的地加完整导航入口。主题/搜索是工具，不作为目的地。
2. 当前题目任务只有一条主线：了解题目与必要材料 → 作答 → 紧接其后的提交 → 接纳/判分/信心/反馈/自评/申诉/下一题。页内tab仅用于真正的同级内容，不把提交或伙伴开关伪装为tab；本片题目与反馈是连续任务，不藏在相互排斥的tab中。已有历史作为次级明细读取。
3. 附件、补充思路、引用与提示属于主任务之后的辅助工具，不允许出现在作答控件和主操作之间。必需材料仍在读题区，多小问必须保持材料/输入关联，不重排语义化PresentationBlocks树的内部顺序。
4. Companion是有独立生命周期的辅助pane，不是导航目的地或普通胶囊。宽桌面并排，768与390因数学/输入需要保主内容最小宽度，按按钮进入完整辅助sheet；关闭只收起，绝不隐式Stop。新会话/历史/用途/引用/排队/流式/多run停止均消费原owner。
5. 选项只展示一个标签：先核真实结构化树、ResponseSlotField和OptionListBlock来源。仅移除与元数据标签完全相符的重复字母标记；不剥合法数字、数学文本、选项ID或提交值，不能重引numeric-prefix P1。
6. 首屏必须看到真实题目、完整主要选项及紧邻作答的主操作；不为此缩小数学文字或截断题干。长内容自然延伸，桌面利用剩余宽度给辅助pane，不做大面积空白居中列。

## Google 官方依据与 Web 决策

2026-10-30实际获取，非博客转述：

- [Navigation rail](https://developer.android.com/develop/ui/compose/components/navigation-rail)："Rails provide access to destinations in apps that run on devices with large screens." rail用于全局目的地，不是当前页锚点。
- [Tabs](https://developer.android.com/develop/ui/compose/components/tabs)："Tabs allow you to organize groups of related content." 页内相关内容与全局导航分层，不把一切控制做成tabs。
- [Layouts and navigation patterns](https://developer.android.com/design/ui/mobile/guides/layout-and-content/layout-and-nav-patterns)："Here, tabs act as a secondary navigation layer to group sibling content." 同页的连续作答流程不用假tab切碎。
- [Canonical layouts / Supporting pane](https://developer.android.com/develop/adaptive-apps/guides/canonical-layouts#supporting_pane)："Secondary pane content is meaningful only in relation to the primary content"。宽屏主/辅区域并排；窄屏可将辅助内容隐藏到sheet，通过按钮进入。
- m3.material.io navigation-rail与tabs直读均为JS-only；不宣称读到完整M3E像素/动画参数。官方Android适配规则不是Web强制断点：本片选择1200px并排、较窄窗口sheet，是考虑80–96px导航、主任务与360px辅助区后的产品决定。现有Web字号/色彩角色优先，不装Compose或新依赖。

`docs/design/2026-10-27-m3e-direction-and-migration.md:9`：
> Owner 已明确 UI 设计、实施、视觉复核由 **Astra** 承担，全面采用 **Google Material 3 Expressive（M3E）**，严格依据 Google 官方规范。
同文:18：
> M3E 改变视觉语言与交互呈现，不重新决定选题、判分、建议生效、题目可用性、读写或恢复规则。

应用design-taste-frontend的完整references/app-screens.md：真实任务第一、清晰阅读顺序、表面按角色分组、导航可识别、主要操作就近、空/加载/错误不虚构。其营销模板、随机选风格、假数据、固定金额舍入、紫色禁令和低于M3触控尺寸的规则不适用于本次既定产品合同。无测试编写/修改/运行。

## 与拒收候选的结构差异

| 拒收结构 | 新结构 |
| --- | --- |
| 练习details/summary下拉承载所有导航 | 跨页面常驻rail；手机核心底栏与完整导航sheet |
| 顶栏一排按钮、宽空白中的单列题面 | 产品标识/目的地在rail，当前任务头在主pane，伙伴为独立辅助pane |
| 题面/选项 → 附件/思路/引用/提示 → 底部提交 | 题面/选项或其它作答 → 主操作和提交状态 → 补充工具 → 结果/历史 |
| 旧workspace布局与CSS继续叠加 | 新practice-studio呈现模块，从任务序列写新DOM/CSS；旧呈现文件不复制、不导入 |
| 内容文本与圆标分别重复标签 | renderer元数据标签为唯一标签源，内容只消除确证字母重复 |
| 平板浮窗挤压/遮挡主任务 | 辅助sheet与原focus/scroll锁，清晰返回题目动作 |

不是宣称作者从未看过旧源码：父必须核对业务投影、安全renderer与真实数据链。复用范围是纯类型合同、原headless owner及必要投影/lifecycle接缝；新页面构图、控件排列、导航和主/辅shell不从旧PracticeSolo DOM复制。

## 文件写集与状态覆盖

组件类型：page + other（全局navigation、supporting pane、原modal呈现）。
新建：src/ui-next/practice-studio/{contracts.ts,StudioShell.tsx,PracticeStudio.tsx,PracticeFields.tsx,PracticeFeedback.tsx,CompanionStudio.tsx,controls.tsx,studio.css,renderers.css,styles.d.ts}（按实现收敛）。
接缝：web/src/RootShell.tsx；practice/ui/PracticeFacePage.tsx、solo/{PracticeSolo,PracticePresentation,FigureLightbox,QuoteSelection,SoloCoach}.tsx；copilot/ui/companion/{CompanionMount,CompanionPanel,Composer}.tsx。标签修正已定位：src/ui/components/response/{ChoiceSetResponse.tsx,display-option-content.ts}、src/capabilities/practice/ui/blocks/OptionListBlock.tsx；新增纯显示helper被两个真实renderer消费，原response-types的存储/摘要逻辑不改。tokens.css仅为practice-studio扩既有opt-in，色值不变。禁止改usePracticeSubmit、所有transport、controller、turn-actions、run-tracker、读写/恢复/receipt/paid/SSE/privacy/cost owner或后端。

状态覆盖：读取/恢复/空/禁止/失败/部分题面；单多选、文本/数值/公式、专用安全renderer、withheld、多小问；草稿保存/冲突/失败；保存与判分分列，未知/接纳待判/失败/确认；信心与自评分离、结果/证据缺失/申诉/下一题；伙伴空/加载/失连/待接纳/流式/多run Stop，保IME与发送排队。三种宽度、明暗、长公式/文本、焦点/折叠/原模态层。

## 其它真实页面迁移顺序

本片交全局导航与做题/伙伴工作区；不能称全站内容重写。随后顺序：练习列表/今日任务 → 题目库/详情 → 录入及已合用途/费用 → 知识/收件箱 → 教学/其它辅助与管理面。每片沿原真实consumer/数据契约，不新建演示入口；FULL业务、后端与其它writer不在本片。

## 可看交付与边界

目标真实item：vn3efyi5hqbduj3mfmkk54yd。按1440或更宽桌面、768、390截图并核导航/主题/伙伴开合/辅助工具层级与键盘。不得提交答案、发消息、启动provider或业务DB写。其它状态只记录源码覆盖/NOT_RUN，不造fixture截图。必要本地type/lint/build及原预算新片R1，不能拿旧diff审查当本片验收。

原生CUA当前报Sky Computer Use native pipe startup failed。技能独立Chrome能运行但无登录态，初次只拍到登录页，不算做题证据；已打开供用户直接登录的独立Chrome，业务非GET请求在检查窗口拦截。正在等待登录，不读取或导出浏览器令牌。源码贯通候选预计60–90分钟；真实截图受该登录前置影响。若界面触发未经授权写请求，不放行来凑验收。

## 新批注：失败回复与本轮操作

Owner在5173旧界面批注MessageRow的“可验证的收口/未封存”文案。定向核实：server/reply-finalization.ts有固定失败文本，ui/message-projection.ts使用incomplete控制primary_view/skill_turn，但未将失败原因保存在ChatMessage供该气泡呈现。UI不能据任意正文字符串重建业务成功/失败/费用状态。保留服务端记录原文；本片新增MessageRow.tsx的纯动作分组，将原更正/撤回callbacks和原可用性原样置于“本轮操作”disclosure。不把失败记录的操作按钮当立即重试建议。

原功能owner后续需给出稳定的失败类型/用户可读原因/允许下一步的实际合同，再由消息消费面呈现；本片不改reply finalization或message-projection owner，不调用provider复现。不假称该条失败的根因已定位。此缺项不阻塞新布局继续落地。

## 首个集成候选

### Owner再次明确：像ChatGPT一样的流式聊天

逐段正文是聊天的基本交互，不是等待最终校验后的结果卡。正文、生成状态、工具操作结果分别呈现；中断应保留已经公开显示的正文并标注中断，不能整段替换为“未封存”等内部提示。停止和重连仍由原run owner负责，不能为了显示正文放宽工具回执/隐私/恢复边界。

源码已核：copilot-execution.ts的prose_delta经过内部注释过滤，subtask-events.ts累积copilot_run.delta；MessageRow已实时消费增长正文。但reply/failed帧用reply_md覆盖正文，finalizer对partial缺少terminalText时failClosed。完整修复需要原stream/replay owner分别提供可恢复的公开部分正文、终态原因与工具结果，不能由UI比较提示字符串或缓存旧正文绕过。该事项已集中记入1473，尚未运行provider验收；本片只将不实的“还未生效”删除，显示“正在回复”。这不是宣称完整流式问题已修复。

新presentation模块已贯通原业务链：StudioShell全局rail/底栏/导航sheet；PracticeStudio按读题/作答/提交/辅助/反馈顺序布局，PracticeFields调用原安全输入renderer，PracticeFeedback分开信心、自评与判分事实；CompanionStudio/StudioComposer用原owner提供slots和actions。新增代码不依赖旧practice-workspace目录，也未复制其DOM/CSS。UI接缝复用了fb1948的业务投影与lifecycle绑定，随后将extras独立后置、全局导航重建、选项纯显示修正。

本地四audit（api-client-usage/capability-boundaries/architecture-deepening/learner-copy）与typecheck/lint/build已全部exit0。初次格式/类型失败日志保留，修正后再次通过；不是测试或真实作答证明。protected owner文件逐字未改。当前候选尚未独立R1/合并，不称视觉达标。截图/交互仍受独立Chrome缺登录态限制；旧before目录只含登录页，禁止作为做题证据。


## 公开正文接入 preflight（原功能父2026-10-30窄wire授权）

本次原UI唯一writer消费仓库外`yuk1413-public-prose-20261030/ui-wire.md`：
> failed/interrupted保public_prose.text并独立状态；无字段旧行沿原合同。
协调明确：completed继续显示sealed reply_md，不拿累计delta覆盖成功终态披露，不重签receipt。此为新授权接缝，替代上文禁止改projection的本片边界；后台仍由原功能writer独占。
组件类型：other（消息正文、状态、流式与回放投影）。新增`copilot/ui/public-prose.ts`；修改`subtask-events.ts`、`message-projection.ts`、`replay.ts`及`companion/MessageRow.tsx`。不改controller/sender/Stop/transport/后台/paid。parser只接白名单，按真实event id折叠快照覆盖段；失败保公开正文和独立安全状态，工具/提案披露仍来自原实际记录。
真实截图发现原native textarea在深色仍吃旧棕色，历史列表仍用旧玻璃卡；只在本片renderers.css重建字段与历史列表表面/尺寸，不改输入/历史选择业务。


## 真实候选核验（2026-10-30补充）

已通过design-taste-frontend的独立Chrome/CDP读取真实5174页面。认证使用现有本机app配置中的原访问令牌，只在进程内送入本机登录输入框；未输出、保存到源码或更改认证。所有非GET/HEAD/OPTIONS请求均拦截，检查记录为0次尝试，不发送聊天/作答/模型请求。原指定vn3efyi5hqbduj3mfmkk54yd已由真实数据标成done，原路由按既有合同回列表；随后只读打开现有in_progress的qdp4zs6gs3811gqyyf0bhjkn，无新start/新会话。

真实截图覆盖1440×1000、768×1024、390×844；明暗题面、伙伴side/sheet、历史列表、手机全局导航。实核三宽document无横向溢出，768作答底478/提交顶531，390作答底511/提交顶560，辅助工具在提交之后。side加宽实测480px，父grid为88/872/480，无横向溢出。Escape先只关闭历史、第二次关闭伙伴；从已聚焦入口打开手机伙伴后，Escape返回同入口。没有输入答案；最终textarea为空。未运行读屏、IME输入/软键盘、提交/判分/工具回执/实际流式provider验收，其余稀有状态仍仅源码覆盖。

真实观察修正：native文本框暗色旧棕色改为作用域M3角色；历史列表改为panel内滚动列表并约束min-height，避免遮住composer；加宽按钮同步调整父grid。旧copilot/nudges缺queryFn控制台报错仍存在，非本片新增，不伪称无运行错误。

新public_prose消费只完成源码与静态门：completed保sealed正文，failed/interrupted独立公开正文和状态；后端新wire尚未部署，截图中旧失败行保持旧协议原文。两份成功正文不要求字节一致。不能以此次真实布局截图宣称新流式行为已运行。

证据目录：`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/yuk1473/practice-studio-20261030/visual/`。本轮checks-streaming内四audit/typecheck/lint/build全部exit0，lint有167条仓库warning；随后仅历史CSSmin-height修正，scoped Biome及build-final-css再次exit0。无测试。全新diff独立R1待回，不复用旧2196报告。
