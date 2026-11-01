# 全产品 M3E 接续：教学阅读与 Generative UI

Owner 在2026-10-30接受新的做题工作区，并明确要求：恢复原吉祥物；以同等质量重写整个UI；优先解决AI教学可读性；prompt只加简短的线性阅读要求；完整Generative UI对齐ChatGPT最新Intelligent UI，支持公式和高级Markdown。继续原唯一Astra/default writer，不另派UI作者。已接受页不重新选风格。

## 官方依据（2026-10-30实读）

- OpenAI 2026-10-07 [GPT-6 and Intelligent UI for everyone](https://openai.com/index/gpt-6-for-everyone/) How Intelligent UI works："We built a library of native, streamable components, along with a compiler"。官方能力是文字、视觉及交互按问题组合，界面可随生成逐步呈现；不是只有最终HTML卡片。
- [Intelligent UI in ChatGPT](https://help.openai.com/en/articles/20001598-intelligent-ui-in-chatgpt)：按任务组织布局、图形、按钮、表单与图表；简单答案仍可只用文字。部分组件状态可以在同会话刷新后保留，不能推断所有交互永久持久化。
- 这些是公开产品能力描述；未取得ChatGPT私有组件库/编译器源码或可直接嵌入本产品的同名SDK，不把自建支持称为接入官方内部实现。

## 任务顺序与完整范围

1. 已接受做题页收口：原R1与新public_prose在途snapshot接缝；恢复每页标题区原玻璃风车花。
2. AI教学阅读：简短的目标→步骤→检查点表达约定，段落和公式清晰；复用现有安全KaTeX链，补表格、删除线、任务列表、脚注、代码块/引用等富文本。不能因为支持HTML就放开Markdown原生HTML执行。
3. Generative UI：现役MessageRow/SkillTurnBlock/HeroBlock/InteractiveArtifactRenderer贯通，文字与多个结构化内容块交错、增量呈现、局部加载/失败/取消、窄屏及明暗、放大阅读、键盘/读屏。控件行为分离为本地探索与需要原业务owner处理的动作，按钮不能自行授权写入。现有sandbox隔离与primary_view授权保留。块身份、顺序、版本、恢复与真实动作回执需与原后端owner明确同一消息合同；不另建第二会话/任务/付费通道。
4. 其它页面依次：练习列表/今日 → 题库/详情 → 录入/用途/费用 → 知识/笔记/收件箱 → 教学其它入口/管理。每片覆盖真实页面及状态，不用统一换token当全部完成。新结构复用headless业务owner，不复制旧DOM当cleanroom。

## 当前切片 preflight

`docs/design/2026-10-27-m3e-direction-and-migration.md` §方向："全面采用 **Google Material 3 Expressive（M3E）**"。
吉祥物沿 `docs/design/2026-10-07-ui-visual-direction.md:253`："吉祥物只出现在页面 banner 的指定位置。" 同文:265："吉祥物始终 `aria-hidden`，不承载信息"。本轮Owner恢复要求明确保留品牌原风车花；M3E页面不改回历史loft样式，不拿花替代logo。

组件类型：page / other（标题区装饰、教学消息、富文本及互动内容）。
第一步owned文件：`src/ui-next/practice-studio/PracticeStudio.tsx`、`studio.css`；原`Mascot`直接复用，不改模型/渲染runtime；`src/capabilities/copilot/tasks/agent.ts`、`teaching-turn.ts`只改短表达要求，不改任务schema/工具/预算/判分。此prompt hunk已告知原功能父，不与其public_prose后台写集交叠。
后续Markdown/Generative UI的具体写集在当前切片收口后按真实consumer补齐，不提前创建无consumer组件库。新增依赖如需GFM与原协调对齐后采用官方包；不更换provider/model。

## 验收

本次是持续实施授权，不是“全部已完成”。先交可运行独立片和真实截图；不虚构交互/来源/统计。provider、真实发送/作答、业务写入与部署仍按既有授权边界，不因视觉方向扩大。prompt源码变更不等于教学输出已改善；模型实际输出验收必须另有真实证据。


### 教学富文本当前写集（实施前补充）

真实consumer为`copilot/ui/companion/MessageRow.tsx`、`SkillTurnBlock.tsx`，两者现用无math/GFM的DeferredMarkdownRenderer。新增同目录`ConversationMarkdown.tsx`，消费已有MathMarkdown的安全图片/LaTeX与官方remark-gfm；为复用扩`ui/lib/math-markdown.tsx`和`markdown-renderer.tsx`的可选插件/components/footnote选项，现有调用默认行为保持。scope CSS在practice-studio/renderers.css，package.json/pnpm-lock.yaml只新增已向协调说明的remark-gfm@4.0.1（官方包实核）。

聊天富文本明确支持LaTeX标记，不以当前页面学科猜历史消息格式；题面既有subject notation gate不变。ReactMarkdown原生HTML默认不执行，KaTeX仍动态加载并同源加载stylesheet；不放宽iframe或URL安全边界。表格只在局部横滚，脚注按消息实例隔离ID；代码块复制纯文本，不执行代码。GFM任务框为只读Markdown记录，不冒充真实任务状态或可写控件。此片不声称完整Generative UI已实现。


## 本片已实现与证据范围

- 原Mascot已回到Practice标题区，一页一朵；桌面与390真实截图见仓库外`tlp-audit-artifacts/yuk1473/teaching-rich-content-20261030/mascot-{desktop,mobile}.png`，当前浏览器data-render=gl。模型/renderer未改；不同GPU/减少动态效果的回退仅复用既有实现，不冒称本轮重新测完。
- CopilotTask与TeachingTurnTask只加短线性阅读要求，前者移除“不像聊天软件”的旧描述；未改工具/预算/schema/判分，未运行provider确认新输出。
- MessageRow与SkillTurnBlock真实消费ConversationMarkdown：LaTeX沿MathMarkdown/KaTeX既有安全链，GFM沿remark-gfm4.0.1；表格局部滚动，消息脚注ID与可访问描述隔离，代码纯文本复制，任务列表不写业务。保原生HTML不执行与受保护图片读取。
- 安装初次被workspace-root检查拒绝，使用明确`-w`后成功，未改全局配置。pnpm锁文件除新增GFM闭包外将既有body-parser@2.4.0标注相同supports-color peer context，未升级其版本。
- 本轮四audit/typecheck/lint/build全部exit0，logs在同artifact的checks/。初次缺依赖与新props可空数组TS错误已修；Vite旧失败解析缓存经重启仅5174前端清除。旧nudges缺queryFn告警仍保留，不冒称控制台无错误。
- 实际页面只读进入与历史切换，0业务写请求、答案空；查看的旧历史无教学正文，故新GFM/聊天数学/代码复制实际内容验收仍NOT_RUN。未造消息/演示状态、不发模型请求。
- 完整Generative UI、其它产品页面的重写仍未完成。原2215只组合到1149，当前follow-up独立，不混进2215原R2或冒称main/部署。
