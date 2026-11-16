# 完整做题界面候选：完整性续作交接

2026-10-29。**SOURCE CANDIDATE / 无 live consumer / 产品验收 NOT_RUN**。
本文件描述修订后的最终合同，替代首版接入说明。服务「第一天能用」完整做题呈现需求（YUK-1473 背景）；没有改变 YUK-1351/1473 状态。

## 实际范围

- workspace：`/Users/yuqi/.t3/worktrees/the-learning-project/t3-6f30155a`
- base / HEAD：`ffaf93f9cc467f7a82e85ceac87af62a4ee41bba`。五文件仍为本树未跟踪的新文件，无 commit、push、PR、checkout、merge、部署。
- 只读确认运行配置仍为 codex / gpt-6-astra / high / serviceTier default。未切配置或委派；这次是实施续作，不是独立 review。
- 文件：`src/ui-next/cleanroom-practice/{contracts.ts,PracticePage.tsx,practice.css}`；`docs/design/2026-10-29-cleanroom-practice-{preflight,handoff}.md`。未改其它源码、export、路由或业务 owner。
- 全程无 useEffect、API/DB/provider、业务状态机、网络恢复、消息发送、fixture/demo、浏览器、服务、测试或部署。DOM refs、组合输入标记只属于呈现交互。

## 补充需求逐条落实

| 补充条目 | 合同与实现位置 | 完成边界 |
|---|---|---|
| 结果前把握1–5，跳过不默认选择 | `Confidence`、`Revelation`；`ConfidenceStep` | nullable value，无默认值；选择只调用 confidence；skip只发父 action id，不发选择。concealed 类型不能包含 result/reference/selfRating；组件也不渲染小问反馈 |
| 自行评级、历史只读、诊断禁提示 | `Submission.grading.manual`、可省略 primary、field.mode、supportActions | 自评在 revealed.selfRating，不依赖自动结果存在；切到自行评级由父动作；readonly+不传primary支持复看，空supportActions不造提示 |
| 专用安全作答及withheld | `AnswerField.specialized/withheld`、`Renderers.answer`、`Answer` | 独立slot传opaque controlId、accessibleName、boundaryId、mode/reason、describedBy/invalid；只有approved才调用。withheld仅显示原因，不textarea替代、不启用业务；锁定时不回传专用intent |
| 多小问题干/材料/输入/反馈 | `QuestionPart` 与 `Result.parts.id`；主页面part section | 题级共同材料在前，小问各自内容和输入相邻；revealed时按part id显示反馈；题级提交动作只一组。父须保证反馈id指向真实part，所有field id在本题内唯一 |
| 真实事实并存 | `recording`、`grading`、`continuation`、`revelation` 各自独立 | 保存成功+判分unknown+已有结果+自评+申诉waiting可同屏；揭晓阶段仅隔离会泄露结果的内容，不吞掉保存/判分事实；原作答控件始终保留 |
| Enter/ShiftEnter/IME | `CompanionPanel` textarea事件 | Enter发送，ShiftEnter换行；compositionStart/end+keyup标记、native isComposing、229、repeat/defaultPrevented检查阻止误发；禁用/队列/发送中/接纳未知/回读中同样拦截按钮和Enter；真实IME NOT_RUN |
| 本轮用途两选项 | `Companion.purpose` 的两项Record、`companionPurpose` | 始终有日常学习/仅本次回答；每项availability与原因，validating/unsupported/rejected各有文案，selected受控；不假装成功，不把更改用途映射为发送 |
| 引用、草稿上下文、新会话、教学/建议 | `contexts[]`、`newSession`、`teachingActions`、`suggestionActions` | 每个context可查看与显式移除；新会话/历史/快捷动作由父提供真实可用项，未实现API |
| 队列、接纳、生成、保存并存 | `Message.delivery` + `Message.state`，composer `sending`，独立`connection` | delivery有queued/sending/acceptance-unknown/accepted/committed；state有waiting/streaming/committed/unknown/partial/refused/failed/cancelled；不以连接状态替代消息状态 |
| Stop与收起分离，正常状态降噪 | 可选`stop`、`canStop`、`consequence` | 只有canStop且有action才渲染按钮；requesting屏蔽重复。idle且不可停止不渲染；费用说明仅在相关Stop区域由父传入，无空会话永久警告；收起只调用companionOpen |
| 多结构消息并存 | `structures[]` + `Renderers.structured` | tool/skill/teaching/proposal/undo可同时存在，各自有安全slot及owner-issued actions；另有正文/引用/消息动作，未推断执行成功 |
| 完整导航与当前位置 | `PracticeView.navigation`；appbar原生details | 所有目的地由父传入，current显示在折叠摘要及展开项；不硬编码目的地，列表限高滚动，不常驻挤压主内容 |
| 稳定identity及生命周期refs | `view.identity`、`Question.id`、`lifecycle` | 提供title/content/companionTitle/companionTrigger四个Ref；标题/主内容可程序性focus；切题不key重挂整页；父在身份变更后的自身UI生命周期用ref定位，无需查询私有类名 |
| 用户语言与正常状态层级 | labels、quiet draft CSS、optional notices | 改为「作答已保存」「生成中，尚未保存」「是否收到尚不确定」；不显示“记录事实/持久提交”。empty草稿隐藏、saving/saved小字；connected不成卡；未作答不再独占状态卡 |
| 更严格M3E参数 | practice.css及下表 | 对已取得参数收敛；中文/Web必要适配逐项声明，不称完全规范认证 |
| spring动效缺口 | 删除首版ease-out/linear transition | 当前只有即时状态/形状切换，无确定性Web spring。具体未完成项见动效表，不宣称“动效已覆盖” |

## 接入与安全合同

父导入 `PracticePage` 并提供 view/renderers/intents/lifecycle；页面显式导入局部CSS。根自带 `[data-ui-next].un-cr`，不读取或导入旧 UiNextRoot；与真实根容器组合须父集成验证。

三个 renderer 接口各有责任：

- `content`：只读题干/材料/解释/引用，按opaque id取真实内容；不得把专用交互塞进此slot。父负责sanitization、媒体alt/caption、公式可读替代、table headers、合法链接及内部overflow。
- `answer`：仅approved专用控件；boundaryId为父已验证边界的标识，并不由此组件证明安全隔离。renderer必须遵守mode/reason、键盘语义与错误关联，不得借此开启网络/扩权。未知payload只回传父验证；withheld时完全不调用slot。
- `structured`：工具/教学/技能/提议/撤销的真实结构内容；动作由外侧owner-issued id触发，不能把正文声明当实际执行成功。

Action label/reason/Notice/announcement均需父提供终端用户语言，不传内部身份、协议或错误栈。native disabled + 明确原因。父决定提示是否存在、原作答是否只读、何时提交/确认/自评/申诉/下一题；本候选没有判断题目类型或规则。需要自动判分转手动时，传manual事实与相应切换action；用户确认后父再提供selfRating，不自动切换。

`Revelation`只管披露边界：concealed仍可呈现保存、判分进度、原作答和把握；revealed可同时展示结果、自评、申诉及已记录把握。concealed阶段不要通过任何rich-text/notice/伙伴slot提前传入结果，这是父数据权限责任。把握步骤存在时普通primary隐藏，避免两个主按钮；continue和skip完全由父控制。skip不调用confidence，包括选择过后又跳过；父决定如何清理未提交选择。

`Message.delivery`是请求/消息交付事实，`state`是内容生成/保存事实，两者不能混为成功；例如accepted+streaming明确表示已收到请求而生成正文尚未保存。`sending`独立于connection与历史消息。每次发送的幂等、按下到下次props更新间的重入仍由真实owner保证，本组件不创建第二发送锁。用途变更也不做乐观值切换。

生命周期：父应传稳定Ref对象或useCallback，不在每次render创造聚焦ref。`titleRef/contentRef`跨题保持同一节点可用，父比较view.identity/Question.id后安排focus/scroll；流式消息不得变化identity。伙伴默认仅mount标题focus；提供companionTitleRef后由父接管，关闭按钮返回trigger。父外部关闭/导航/原触发器删除时须使用公开refs安排落点。dialog保持native showModal/Escape/dismiss/cleanup焦点返回；StrictMode/跨modal行为未运行。

## 页面状态矩阵

每行均 **源码能力；真实业务/浏览器/AT/IME运行 NOT_RUN**。共同规则：native控件、普通Tab顺序、可见focus、文字与符号状态；长内容不省略、math/table/code具名可聚焦横滚；明暗同语义色；无位移/高度动画；窄窗与短窗单pane。父决定权限与动作，不以这张表证明组合业务合法。

| 区域 | 状态及可见信息 | 动作、编辑与组合 |
|---|---|---|
| 页 | loading/recovering/empty/forbidden/failed/ready/partial | 框架与返回始终存在；父恢复action；无虚构题；partial可与媒体失败并存 |
| 内容 | 长短标题、共同材料、小问材料、loading/failed/missing | id关联part；媒体/引用/原图缺失notice；父slot负责原图等真实入口 |
| 输入 | single/multiple/text/number/formula/attachments/specialized/withheld | 默认不选答案；readonly文本可复制；选择readonly用disabled+说明；busy/invalid关联原因；IME作答不隐式提交 |
| 输入视觉 | default/hover/focus-visible/pressed/selected/disabled/read-only/invalid/busy | 原生语义加state layers；48px最小命中、可换行选项；长文本textarea垂直resize |
| 上传 | uploading(progress或未知)/failed/complete | 父retry/remove动作；上传不等于草稿保存或作答提交；same-file可重选 |
| 草稿 | restoring/empty/saving/saved/offline/failed/conflict | 正常状态轻量；冲突展示本地/远端，窄窗纵列；父恢复选项，无自动覆盖 |
| 保存事实 | idle/saving/saved/unknown/failed | 保存中屏蔽主提交；unknown不自动重发；与grading/result独立 |
| 判分 | idle/pending/grading/unknown/failed/settled/manual | 未判、人工评级与已记录作答可并存；父提供查询/转自评；不将接纳当已判 |
| 把握 | concealed、value null/1–5、disabled/busy、skip/continue | 不显示结果/参考/小问反馈，跳过不发选择；原作答保留 |
| 结果 | correct/partial/incorrect/unanswered/review/unknown | 文字+符号；结果可空；参考missing/unavailable reason；依据/不确定性；part feedback贴近本小问 |
| 自评/确认 | revealed.selfRating + continuation.confirmation | 与把握独立、无默认值；可无自动result；已有记录不被自评覆盖 |
| 申诉 | available/editing/sending/waiting/failed/resolved | 表单与原结果/unknown判分可同屏；父控制申诉能力与原因 |
| 下一题 | continuation.advancing | 主按钮禁重复，原题与结果保留直到父切identity |
| 伙伴 | closed/open、summary loading/empty/failed/ready | 收起不Stop；空摘要不成卡；错误与消息并存；无逐tokenlive播报 |
| 历史/上下文 | sessions loading/empty/failed/ready；contexts多个 | 历史disclosure，current标记；引用/草稿context查看+移除；新会话/教学/建议动作可用性父控 |
| 用途 | ready/validating/unsupported/rejected | 两个native radio各自availability；未选不发送，validating期间不改值；切换结果父维护 |
| 消息交付 | queued/sending/acceptance-unknown/accepted/committed | 每条消息独立，不只贴连接标签；正文与多种结构、引用及actions可同时有 |
| 消息内容 | waiting/streaming/committed/unknown/partial/refused/failed/cancelled | streaming明确尚未保存；不自动滚底；parent announcement只播去重短句 |
| composer | idle/queued/sending/acceptance-unknown/accepted/reading-back/failed | Enter与按钮共用门槛；ShiftEnter换行；composition标记+229+keyup保护；父disabled仍优先 |
| 连接 | connected/acceptance-unknown/disconnected/reconnecting/refresh-failed/confirmation | 正常connected降噪，异常持久notice；可与streaming+Stop unknown同时显示 |
| Stop | absent/idle/requesting/confirmed/unknown/failed | canStop控制按钮；requesting禁重复；相关consequence才展示费用/撤回限制，关闭不改变Stop |
| 导航/浮层 | 完整父nav、native disclosures、阻断dialog、持久feedback | 无虚构目的地；非模态伙伴；dialog Escape/取消/焦点返回；重要恢复不toast |
| 布局 | compact/medium/wide/short、长内容、200%文字、深浅、软键盘 | ≥75rem且高≥30rem才两列；冲突≥37.5rem双列；无fixed composer；safe-area预留；真实缩放/软键盘/读屏 NOT_RUN |

## 官方证据与具体参数

Google官方网页：已在首轮亲读 [Expressive研究](https://design.google/library/expressive-material-design-google-research)、[adaptive window classes](https://developer.android.com/develop/ui/compose/layouts/adaptive/use-window-size-classes)、web.dev [focus](https://web.dev/learn/accessibility/focus/)、[contrast](https://web.dev/learn/accessibility/color-contrast/)、[motion](https://web.dev/learn/accessibility/motion)。这些只支持设计依据，不是本候选实测效果。

`m3.material.io/get-started`、styles/color/the-color-system、styles/typography/overview、styles/shape、styles/motion、components 首轮全部返回JS壳。未读到组件Specs/Guidelines/Accessibility正文，未开浏览器绕过限制，不能宣称完整规范认证。

固定 [AndroidX官方tokens目录](https://github.com/androidx/androidx/tree/9b2acdf2ecd36aa5ddf9c43ebfc288ed11d2c49e/compose/material3/material3/src/commonMain/kotlin/androidx/compose/material3/tokens)，revision `9b2acdf2ecd36aa5ddf9c43ebfc288ed11d2c49e`。首轮读取ShapeTokens、TypeScaleTokens、StateTokens、FilledButtonTokens、ButtonSmallTokens、ColorLightTokens、ColorDarkTokens、PaletteTokens、ElevationTokens、CheckboxTokens、OutlinedTextFieldTokens、DialogTokens、SmallIconButtonTokens、MotionSchemeKeyTokens、ExpressiveMotionTokens及上级MotionScheme.kt。相关shape/type/palette值在初次输出截断后重取。续作重新读取OutlinedTextFieldTokens、TypeScaleTokens、TypefaceTokens相关字段。

| 官方参数 | 当前源码 | Web/中文适配或缺口 |
|---|---|---|
| ShapeTokens 4/8/12/16/20/28/32/48dp/full | xs4、small8、medium12、large16、xl28、full；按钮pressed8 | dp→CSS px再按16px基准转rem，随文字缩放；非Android像素认证 |
| bodyLarge16/24；headlineSmall24、emphasized medium；titleLarge22/28、emphasized medium；titleMedium emphasized bold | 正文16；h1 24/500；h2 22/500；h3 16/700 | 系统字体替代Roboto，无网络字体；中文正文line-height1.65、阅读1.8及标题1.35/1.4为可读性适配，未冒充官方line-height |
| labelLarge14/20 regular role weight medium；emphasized bold | 按钮14/500，行高1.4约19.6px | 修订取消任意600，普通动作使用medium；正式字体渲染仍NOT_RUN |
| OutlinedTextField height56、cornerExtraSmall4、outline1、focusOutline2 | textarea min56px、4px corner、1px border，focus-visible2px inward outline | 多行高度按内容/rows增加，长中文line-height1.65；无自造floating label，外置legend/label为原生表单适配 |
| StateTokens hover.08、focus/pressed.10；ButtonSmall40dp/full/pressed8；16dp水平padding | 40px视觉面嵌入48px点击区、padding16、pressed8；layer.08/.10 | 48px为本页触控目标，不混为官方40dp视觉height；长label可增高。disabled保留可读对比+虚线，明确偏离官方低opacity |
| CheckboxTokens18dp、40dp state layer | native20px控件+整行48px以上target | 为原生keyboard/UA语义保留20px，非Android精确复刻；选中色用primary |
| ColorLight/Dark+Palette角色对 | surface/low/container/high、ink/muted/outline、primary/onPrimary、tonal/onTonal、error | 官方baseline hex，未读旧token；显式theme由父解析OS偏好 |
| DialogTokens high/28/level3，ElevationTokens0/1/3/6/8/12 | dialog high+28，shadow offset6；阅读容器无shadow | CSS shadow blur18px是Web近似，不宣称官方shadow参数 |
| FocusIndicatorTokens.kt | 固定路径404，官方目录列表未找到名称含Focus的token | 通用3px focus ring/3px offset保留为显式项目可访问适配；未取得通用官方ring数值。文本框2px来自已读token，不混淆两者 |
| NavigationRailTokens.kt | 首轮固定路径404 | 不做未经证实的rail；全量导航用语义nav和原生disclosure，无隐藏业务目的地 |

未读取material-web，不假设官方React Expressive库。原生菜单disclosure不是ARIA menu；本页无icon-only按钮/tooltip/自动snackbar/sheet，因为必要操作有文字且恢复信息应持久。伙伴是complementary，非伪模态sheet。

### 动效准确缺口（M3E motion 尚未完成）

官方Expressive参数已取得：default spatial damping .8/stiffness380，fast spatial .6/800，slow spatial .8/200；default effects1/1600，fast effects1/3800，slow effects1/800。AndroidX MotionScheme用对应spring spec，不是固定duration曲线。

| 变化 | 应归属 | 当前实现 / 未完成 |
|---|---|---|
| 按钮full→pressed8形状 | fast spatial | 即时CSS状态切换。缺确定性Web spring、打断/回弹与反向连续性实现；未用任意ease-out替代 |
| hover/focus/pressed层opacity | fast effects | 即时.08/.10，无duration近似。缺按effects spring推进和有界opacity输出 |
| panel开关、宽窄布局切换 | spatial（若后续动画） | 当前无位移/尺寸动画，保持文档流；并非声称完成pane spring；是否需要动画须父真实布局验证 |
| 判分/保存事实、长材料增加 | 无需装饰动画 | 直接更新文字，不制造成功、不自动滚动，不用高度动画移动阅读位置 |
| reduced-motion | 用户偏好优先 | 当前所有候选transition/animation均无，天然即时；未来spring必须提供关闭/即时路径并验证，当前未证明Web spring模式与reduced-motion切换 |

首版120ms linear/160ms ease-out已删除。**不能对外报告“完整M3E动效完成”**；本轮允许准确保留这一缺口，没有引入未经验证的动画框架。

## 自我攻击与修订

- 把握泄露参考：concealed类型及渲染路径隔离result/reference/part feedback；父不得在其它slot偷偷传结果。跳过只发action，不把null变3。
- manual题被强迫提交：primary可完全不存在，selfRating不依赖自动result，supportActions可空；未编码自动“提示/提交”入口。
- 控件安全边界被方便性绕开：specialized必须approved，withheld不调用renderer。boundaryId只是证据引用，真实隔离依然由父验证。
- 多小问脱离上下文：每part内容/材料/字段/反馈在同一section；id经编码用于DOM关联。父须保证field id唯一、反馈part id有效。
- IME最后Enter误发：组合期间、229、compositionend后的确认Enter均拦截；keyup清理标记。点击候选后若没有确认键keyup，可能保守阻止第一次Enter，按钮仍可发送；真实各平台IME验收NOT_RUN，不以静态检查冒充。
- 接纳未知仍发送：按钮与Enter同时读sendBlocked，包含sending未知/回读和connection未知；没有自动重发。
- 用途受限仍假装可用：两选项每项有availability/reason，拒绝/校验状态保持父value；没有乐观成功。
- 伙伴恢复事实丢失：connection、sending、每条delivery/state、Stop分开，structured数组允许多个结果，不让单个error覆盖全部。
- 空会话被警告填满：Stop absent/idle不可用不渲染，consequence仅动作相关，connected/empty summary降噪。
- 正常草稿大卡挤占作答：empty隐藏，saving/saved小字无背景，提交区取消边框；冲突仍完整双版本。
- 父切题只能重新挂载：公开四个stable refs与identity，main/title无question-key；父有直接焦点节点，不需私有类名。父必须保持ref稳定。
- 导航折叠丢current：summary显示真实current label，展开保留所有items；列表限高局部滚动；没有新目的地。
- 已取得参数仍任意改数值：field4/56/focus2、type500/700收敛；其余适配/未知逐项标注。物理motion未实现如实保留。

## 实际读取清单与隔离自证

本次续作主动读取：

1. `/Volumes/YukovalSBak/yukoval-projects/tlp-status/review/yuk1473-cleanroom-m3e-20261029/completeness-amendment.md`，完整。
2. 本次自己新写的 `contracts.ts`、`PracticePage.tsx`、`practice.css`；修改文档时读取自己原有 `preflight.md`。`handoff.md`以已知需求与证据重写，不读父探索记录。
3. Git仅pwd/status/rev-parse元数据；T3仅当前线程配置。没有git diff/show或索引搜索旧代码。

同一任务首轮还读过：完整requirements.md；cwd AGENTS.md、src/ui-next/AGENTS.md；package.json、tsconfig.json；`/Users/yuqi/.agents/skills/design-taste-frontend/SKILL.md`及references/app-screens.md（后者输出截断，未宣称完整遵循其流程）。检查过src/AGENTS.md、docs/AGENTS.md、docs/design/AGENTS.md是否存在，未读到文件。

未主动读PLAN/.remember/个人memory、旧产品TS/TSX/CSS/截图/diff/构建包/页面/设计历史、父新探索记录。平台首轮自动提供memory summary不是本候选产品输入。未触及父树或运行中的另一工作树。格式/类型工具会读取自身配置、标准库及React/Vite工具类型，不以其读取产品实现。

首轮pnpm exec曾自动链接缓存依赖（1044包，downloaded0），无package/lock修改；本轮未改依赖。Linear capture无新旧产品bug调查，本轮缺口为已授权待集成工作，不新增票或改1351/1473状态。

## 检查及交接边界

实际仅运行新文件静态检查：

```sh
pnpm exec biome check --write src/ui-next/cleanroom-practice
pnpm exec biome check src/ui-next/cleanroom-practice
pnpm exec tsc --ignoreConfig --noEmit --strict --skipLibCheck --jsx react-jsx --target ES2022 --module esnext --moduleResolution bundler --lib ES2022,DOM,DOM.Iterable --types react,vite/client src/ui-next/cleanroom-practice/contracts.ts src/ui-next/cleanroom-practice/PracticePage.tsx
```

最终检查通过。中间未用参数/import排序、Results旧prop的检查失败已修复；没有全仓typecheck/lint/build。保留一条带理由的局部Biome suppression：可横滚math/table/code区域须tabIndex0供键盘滚动。首轮42对静态颜色检查通过；本轮未改hex，未重新运行或冒充浏览器对比验证。

所有业务/浏览器/IME/键盘/AT/截图/200%缩放/软键盘/forced-colors/明暗/真实恢复与Stop/专用隔离运行验收 **NOT_RUN**。没有fixture替代真实数据，没有测试/服务/部署。

父线下一步：fresh-main接候选，映射真实owner及所有导航/动作；提供安全content/structured/answer renderer与boundary证据；按公开refs接焦点、主题与身份转换；在真实内容/组合状态下完成视觉、键盘、IME与AT验收，并按父权限做集成检查。M3E确定性Web spring仍是明确未完成项，不应在集成报告中消失。本次只证明候选源码与静态类型可检查，不证明产品替换或业务正确。
