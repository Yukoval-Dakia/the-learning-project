# 做题工作区：父接入合同与未验收边界

这是完整呈现源码候选，尚无 live consumer，未替换产品。没有视觉评分，源码完整不代表视觉质量合格。PR2196、父接入树、旧产品实现均未访问或修改。

实际 workspace：`/Users/yuqi/.t3/worktrees/the-learning-project/t3-498e157e`。
Base：`ffaf93f9cc467f7a82e85ceac87af62a4ee41bba`；初始 clean。实现前论证见同目录 `2026-10-29-practice-workspace-preflight.md`。

## 文件表

文件均在 `src/ui-next/practice-workspace/`，无公共 barrel/路由改动。

| 文件 | 完整职责 |
| --- | --- |
| index.ts | 唯一组件出口 PracticeWorkspace + 类型 |
| contracts.ts | 完整保留输入合同，追加 WorkspacePresentation，不新增业务 owner |
| PracticeWorkspace.tsx | 导航、主题、主页面、伙伴 dock/sheet、确认 dialog、生命周期 refs |
| ReadingWorkspace.tsx | 题身份、材料与题干引用、小问、草稿冲突、提交/判分独立事实、阶段动作 |
| AnswerWorkspace.tsx | 原生选择/文本/数值/公式/上传、withheld、approved 安全控件 |
| ResultWorkspace.tsx | 揭晓前把握、揭晓后结果/参考/证据/评级/申诉 |
| CompanionWorkspace.tsx | 摘要、历史、消息、结构结果、Composer/用途/引用/发送/多 run Stop |
| controls.tsx | 私有 action、icon、tooltip、notice、安全内容容器 |
| workspace.css | 作用域语义色、层级/排版/组件形状、响应式、真实消费的 motion |
| styles.d.ts | scoped 编译所需 CSS import 声明，不修改项目配置 |

## 父接入：不能省略的 wiring

1. 在既有 `UiNextRoot`（`[data-ui-next]`）内挂唯一 `PracticeWorkspace`。只读需求合同复制为新 types，没有 import 任何产品实现。所有 action id 原样传回；不解释成 URL、不发送请求、不持久化、不重放。
2. `WorkspaceProps` 保留原 `view/renderers/intents/surfaces/lifecycle`。新增必填 `presentation`：`companionMode`（docked/sheet）、`externalModalOpen`、`quotes`、`modalRef`；可选 `selection`、`runs`。这些是响应式与呈现事实，不是第二业务状态机。
3. 父响应式适配器必须在可用宽度 <1200 CSS px 时选择 sheet；>=1200 且正文有足够行宽才 docked。仅看屏幕宽度不够，200% 文字与宿主容器也需要核实。模式变化会重新挂载伙伴呈现；历史开合是局部 UI state，可重置，消息/草稿/发送事实来自父，不能重建业务 session。
4. 父 `modalRef` 必须为稳定 callback ref：为每个 dialog 注册/释放原共享 overlay coordinator 与**计数式 body scroll lock**。实现调用 React 19 ref cleanup；没有 cleanup 则调用 null。不要传一个 object ref 管多个模态。native `showModal()` 提供 inert/focus trap，卸载关闭并恢复原聚焦节点；不读旧 focus hook、不使用 useEffect。
5. 外部图片/提示模态必须在伙伴之后进入浏览器 top layer，设置 `externalModalOpen`，并用父既有生命周期恢复焦点。普通定位 div 无法盖过 native dialog；不要靠更大 z-index。确认 modal 在伙伴之后挂载；已经打开确认时不得又从外部开启新的底层 sheet。父需串行顶层开合。
6. `quotes[content.id]` 由 owner 提供整题/材料/小问引用动作。`selection` 提供真实选区预览与 owner intent；选区采集仍由既有 owner 承担。当前候选不调用 Selection API，不在 mouseup 假定引用成功。成功由 `feedback` / 去重 `announcement` / `contexts` 到达后体现。键盘可通过常驻引用动作和 selection 区操作。
7. `runs` 是多个独立 run 的 Stop；若使用，勿把相同 run 再放入单个 `companion.stop`。关闭只调用 `companionOpen(false)`。Stop 能否请求、请求中/确认/未知/失败和费用边界均直接展示 owner 数据。
8. `renderers.content` 负责数学、安全富文本、媒体 alt/caption/loading/error/原图；`structured` 负责结构结果与执行事实；`answer` 只在 safety.approved 调用，包含 boundaryId、mode、reason、describedBy 和 invalid。withheld 不降级 textarea。不得把互动答案塞进 content slot。
9. `questionBody` 保留为兼容的互斥高级安全题型树；默认所有材料、字段、小问、伙伴内部均由新代码绘制。不要用此 slot 搬入旧可见产品 UI，不要隐藏挂旧页面来维持 owner。history/conflict 也有完整原生呈现，可不用 override。
10. refs 全保留：issuancePlaceholder/title/content/answeringRoot/quotable/submitActions/result/companionTitle/companionTrigger。父在 identity 转换时进行焦点迁移；流式消息只更新内容，不抢焦点。单个页面实例使用固定 skip/composer 关联 id；不得在同一文档挂两个实例。
11. `Action.availability` 决定提交/提示/继续/跳过/恢复等；历史只读题 omit primary。把握阶段不要同时给提交 primary 与 confidence.continue 两个主动作。用途 null 不默认选中；不支持/校验中原因来自父。sender 还禁止 acceptance-unknown/reading-back/sending/queued 下 Enter 或点击重发。

## 层级表与键盘

| 层 | 实现 | Escape / 焦点 |
| --- | --- | --- |
| 页面/desktop companion | 普通 landmarks，无遮挡 sticky footer | 原生 Tab 顺序；父 identity refs |
| 导航 disclosure / tooltip | 页面内部 z=2/3 | disclosure 原生 summary；tooltip hover/focus 可见 |
| 伙伴 sheet | native modal top layer，内部滚动、dvh、安全区 | history 开启时先关闭 history 并返回其 trigger；否则 close companion，绝不 Stop |
| 图片/提示/确认 | native top layer，后开者最高 | 仅最高层处理；externalModalOpen 阻止底层 dismiss；确认取消由父 intent |

Modal 使用 native focus trap；body scroll lock 特意交父已有生命周期，避免本候选建立第二锁 owner。进入/退出动画不延迟 owner intent。窄屏 Composer 位于面板滚动流中，没有 fixed 底部遮挡；软键盘下实际 visual viewport、iOS body 锁和焦点可见性 NOT_RUN。

## 状态矩阵与静态自攻

所有行的真实页面截图、键盘、读屏、触屏、亮暗、200% 字体与长内容组合均 **NOT_RUN**。表中是源码能力和接入要求，不是运行通过记录。

| 区域与事实 | 可见内容/动作/编辑性 | focus / announce / 溢出 | 最可能失败之处与当前处理 |
| --- | --- | --- | --- |
| loading / recovering | notice 标题、动作；返回/全量导航/伙伴入口始终在 appbar | busy + placeholder/title ref；只有父去重 announcement live | 不伪造百分比；父若禁用返回必须给原因 |
| empty / forbidden / failed | 独立 page kind 的 notice、原 action | title ref；无虚构作答框 | 不能同一错误文字替代原因，父填真实 notice |
| partial / ready | 原题 + missing notice，字段与阶段动作可组合 | identity refs，不按流式 remount | 不因材料缺失隐藏整题；是否禁提交由父 availability |
| 阅读/材料/小问 | 来源/进度仅真实值；材料在题干旁，小问输入同 section | content 自身横滚并可聚焦；safe renderer 负责媒体内部可达性 | 中文/公式宽度需真实检查；源码不删选项字母 |
| single / multiple | 内容行 + 原生输入；selected 有边线/背景/形状 | radio 原生方向键；checkbox Tab/Space；错误描述关联 | readonly 选择输入 disabled，内容仍可读；不是可交互假只读 |
| text / number / formula | 56px min 字段、4px shape、readonly/disabled/busy/error | input/textarea 原生粘贴/IME；数值保留字符串不解析 | 公式专用需求必须用 approved renderer；不能自动改写值 |
| specialized / withheld | approved 才调用安全答案，withheld 说明原因 | boundary/mode/reason/invalid/describedBy 全传 | 安全保证来自父，未运行验证 |
| 附件 uploading / failed / complete | 原文件名、真实可选进度、状态/动作 | 文件输入可达，列表滚动；仅 native 文件选择 | owner progress 以 0–100 输入；缺进度显示不确定 progress，不假完成 |
| empty / restoring / saving / saved | empty 不占卡片，其余轻量 notice | announcement 只从父读取 | 恢复/保存不能因 UI 动画变成 saved |
| offline / failed / conflict | 原因 + owner 恢复 actions，冲突本地/远端并排，窄屏纵向 | 冲突长内容各自横滚 | 不自动覆盖远端；若 owner 未给选择不编造恢复 |
| recording / grading / continuation | 独立事实，未知/待判/手动/失败有默认用户文案 | 不根据 HTTP 接纳推导结果；动作在末尾 | saved+unknown 可同时显示，不合并为成功或失败 |
| concealed confidence | 1–5 无默认选择，跳过/继续原 intent，不渲染参考 | 原生 radio，disabled 原因 | 不将跳过发送成中间值；父决定何时揭晓 |
| revealed verdict / reference / evidence | 图形+文字结论→小问→解释/参考→证据→不确定性 | result ref；无参考只显示原因 | 不通过 CSS 隐藏未揭晓答案，而根本不渲染 |
| rating / appeal | 结果后独立评级、确认 actions、申诉字段/notice | 原生输入+原因；waiting/failed 可并列原结果 | appeal field 沿用字段 intent id，不新建提交 owner |
| companion closed/open | 明确 icon+短标签+expanded feedback；dock 或 sheet | close 返回 trigger；关闭不 Stop | 父响应式事实错误会挤压正文，必须接入验收 |
| summary loading/empty/failed/ready | disclosure 内真实摘要或 notice | 不挤占空会话主区域 | 摘要默认折叠，真实任务下是否需要默认展开待验证 |
| history loading/empty/failed/ready | 完整列表/current/action + 返回对话 | Escape 首关 history，返回 history trigger | 外部 override 须遵守同一键盘/语义合同 |
| messages queued/sending/accepted/unknown | delivery 与 reply state 分开，只有 committed 说已保存 | 消息不是 live region，不逐 token 播报 | accepted 不等于完成；父 announcement 去重 |
| streaming/partial/refused/failed/cancelled | 正文+明确状态；结构结果各有 actions、来源折叠 | 内容局部横滚，draft 不随刷新丢失 | 不推断工具执行成功，不制造自动重试 |
| connection disconnected/reconnecting/refresh-failed/confirmation | 连接 notice 与 owner actions | 重要状态不自动消失 | connected 正常时不铺状态标签 |
| Composer/purpose/contexts | 预览/移除、用途、文本、send；真正可用才发送 | Enter/ShiftEnter；composition ref + native isComposing + keyCode229 + repeat 防误发 | IME 跨浏览器差异仍需实测；不请求模型 |
| Stop 单/多 run | 显式状态/后果/动作；关闭独立 | 每个 run 保留身份 | 不承诺撤回在途 provider 请求或免收费 |
| 所有 action | 48px target，default/hover/focus/pressed/disabled/busy，原因文本 | 3px focus outline；disabled native | tooltip Escape 先关闭自身；仍需真实读屏与指针 hover 验证 |
| 响应式/短窗 | >=1200 两区；中屏 modal；<600 sheet/16px gutter；无固定底栏 | native dialog 限高可滚；content 内横滚 | 200%/短窗/键盘/亮暗/模态组合待真实验证 |

## 逐区域设计反驳

- **框架**：首屏没有成排同形工具，导航 disclosure/主题 icon/伙伴工作区入口形态不同，但窄屏 appbar 换行仍可能吃高度。已经将题目标题限制到 22px，并删除虚构统计；三秒识别属于真实视觉验收，不能静态保证。
- **阅读**：平面阅读轴 + 左线材料 + 作答容器区分任务。风险是长材料使作答很远；不擅自折叠关键信息或造分页，父用真实内容评估。
- **作答**：选项不是按钮胶囊，选中有边线与原生控件。风险是超长数学节点导致横向滚动；容器 min-width:0 + 内容局部 overflow，实际 renderer 必须验证。
- **结果**：结论只给一处高强调，其后证据/评级/申诉有不同层次。unknown/partial 使用文字和图形，颜色不独自承载结果；真实结果篇幅仍可能使下一步滚远，不能在未测前加入遮挡式固定 footer。
- **伙伴**：轮廓独立的辅助空间，摘要/历史降密度，正文与用户消息形态不同，Composer 有明确边界。风险是 360px 中英文混合内容密集；不留空壳依赖旧按钮，真实消息/结构结果密度待核。
- **引用**：题干/材料右下轻量图标+短 action label，context 用左线预览与独立移除。风险是父 action.label 太长恢复为冗长文字；父应提供“引用题干”“引用材料”等真实简短标签，不改 intent id。
- **主题**：太阳/月亮图标、完整 accessible name 与 hover/focus tooltip；自选绿系语义 pairs。没有远程字体或官方 palette 冒称；应以真实字体/renderer 测完整对比。
- **叠层**：native dialog 可以解决 focus trap，但父旧 overlays 若非 top layer 将被遮挡，这是必须接入解决的风险，不能靠 z-index 拼接。

## 官方来源、取值与适配

亲读 Google 研究文章：https://design.google/library/expressive-material-design-google-research 。采用任务层级与功能分组的原则；不将 Google 研究效果数字转述为本页面效果。

亲读窗口分类：https://developer.android.com/develop/ui/compose/layouts/adaptive/use-window-size-classes 。官方 compact <600dp / medium 600–840dp / expanded 840–1200dp。本文 CSS 600/1200 分界是学习阅读空间的 Web 适配，非 dp 等价保证。

M3 motion https://m3.material.io/styles/motion 返回 “This website requires JavaScript.”，未取得 Specs 的完整网页内容；不冒称网页全读。固定官方源码 revision 为 `8872fe426fbb8c10626af52e4e792f5c8558b438`，以下链接使用该 revision：

- [ButtonSmallTokens](https://github.com/androidx/androidx/blob/8872fe426fbb8c10626af52e4e792f5c8558b438/compose/material3/material3/src/commonMain/kotlin/androidx/compose/material3/tokens/ButtonSmallTokens.kt)：40dp container、20dp icon、8dp gap、16dp horizontal space、round/full、square/medium、pressed/small。当前 action target 48 CSS px（Web 触控适配，不是原官方 40 container），图标20、gap8、padding16；primary round，pressed8。
- [OutlinedTextFieldTokens](https://github.com/androidx/androidx/blob/8872fe426fbb8c10626af52e4e792f5c8558b438/compose/material3/material3/src/commonMain/kotlin/androidx/compose/material3/tokens/OutlinedTextFieldTokens.kt)：56dp height、extra-small shape、1dp outline、2dp focus。CSS 56px min/4px corner/1px border+1px inset focus；外加3px focus-visible 是 Web 可访问适配。
- [ShapeTokens](https://github.com/androidx/androidx/blob/8872fe426fbb8c10626af52e4e792f5c8558b438/compose/material3/material3/src/commonMain/kotlin/androidx/compose/material3/tokens/ShapeTokens.kt)：4/8/12/16/20/28 scale 对应输入/pressed/选项/答案/Composer/伙伴与dialog；伙伴 trigger 非对称轮廓和消息角是项目选择，不是官方组件精确 shape。
- [TypeScaleTokens](https://github.com/androidx/androidx/blob/8872fe426fbb8c10626af52e4e792f5c8558b438/compose/material3/material3/src/commonMain/kotlin/androidx/compose/material3/tokens/TypeScaleTokens.kt)：title large 22/28、body large16/24、label large14/20。题目22/28；正文16/1.85和标题600权重为中文长读适配；系统中文字体回退不是 Google 字体等价。
- [ExpressiveMotionTokens](https://github.com/androidx/androidx/blob/8872fe426fbb8c10626af52e4e792f5c8558b438/compose/material3/material3/src/commonMain/kotlin/androidx/compose/material3/tokens/ExpressiveMotionTokens.kt)：fast spatial damping .6 / stiffness800，fast effects1 /3800；default spatial .8 /380、effects1 /1600；slow spatial .8 /200、effects1 /800。
- [MotionTokens](https://github.com/androidx/androidx/blob/8872fe426fbb8c10626af52e4e792f5c8558b438/compose/material3/material3/src/commonMain/kotlin/androidx/compose/material3/tokens/MotionTokens.kt)：旧 duration/easing fallback 的150/200ms 与(.2,0,0,1)；不称之为 Expressive spring。

Web motion：将 fast spring 作为单位质量二阶阶跃响应，spatial 0.5s / effects0.2s 各60段采样到 CSS linear()，末端强制1。支持时实际用于按钮/选中形状、背景和 details 展开收起；不支持用上述明确的 duration/easing fallback。有限时长、采样和重定向由 CSS transition 决定，不是中断速度连续的物理系统。reduced-motion 关闭全部 transition。sheet mount/unmount 即时，未实现退出空间动画，避免延迟关闭与业务 intent；完整官方 motion 对齐仍有此明确缺口。

## 检查记录与精确未完项

仅运行新增目录文件检查；没有测试、全仓 typecheck/lint/build、浏览器、服务、DB、provider、paid、部署、commit/push/PR 或 Linear。

首轮 `pnpm exec` 意外触发工具环境按既有 lockfile 恢复 node_modules（1044 packages），没有新增依赖；随后直接使用 `node_modules/.bin`。tracked status 未出现 package/lock/config 变更。首轮 tsc 报 CSS 声明缺失、PageState/availability 收窄错误，已在新目录修复。

最终命令与输出：

```text
node_modules/.bin/tsc --ignoreConfig --noEmit --strict --skipLibCheck --jsx react-jsx --target es2022 --module esnext --moduleResolution bundler --lib dom,dom.iterable,esnext src/ui-next/practice-workspace/*.ts src/ui-next/practice-workspace/*.tsx
(exit 0; no diagnostics)
node_modules/.bin/biome format src/ui-next/practice-workspace
Checked 10 files. No fixes applied. (exit 0)
```

未完：父真实 consumer 与 controller wiring、共享 body scroll lock/外部 top-layer 协调、真实媒体与专用安全 renderer、选区采集、响应式 adapter、真实截图与全状态/键盘/IME/亮暗/200%/短窗/软键盘/读屏验证均 NOT_RUN。sheet 退出空间动画仍未实现；CSS spring 为有限采样近似，不能宣称全部 M3E 规范完成。源码级候选已提供，最终产品验收由父接入后进行。
