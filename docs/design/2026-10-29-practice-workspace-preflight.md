# 做题工作区：实施前设计论证

实际 workspace：`/Users/yuqi/.t3/worktrees/the-learning-project/t3-498e157e`。
Base：`ffaf93f9cc467f7a82e85ceac87af62a4ee41bba`；启动 git status --short 无输出。
仅阅读指定四份需求/合同、工具配置、AGENTS 与 Google 官方资料；不读取个人 memory 或旧实现。

## 原文与范围

rewrite-brief.md「锁定规范与读取边界」转引方向文档 §1：
> Owner 已明确 UI 设计、实施、视觉复核由 **Astra** 承担，全面采用 **Google Material 3 Expressive（M3E）**，严格依据 Google 官方规范。
> M3E 改变视觉语言与交互呈现，不重新决定选题、判分、建议生效、题目可用性、读写或恢复规则。

rewrite-brief.md「一句话任务及信息顺序」：
> 题干和作答是主工作区；导航/工具退到辅助层；伙伴是可识别的辅助工作区。

组件类型：page + navigation + complementary + modal。owner 本轮授权覆盖 nested AGENTS 的旧路径读取、旧 focus hook、showcase、全仓 gate；不读取或复用旧 hook。native dialog 管模态焦点，父层提供外部安全 overlay 生命周期。

## 对象与动作（先于实施）

1. 导航来自父提供的完整目的地集合；收在 disclosure，当前路径常驻。
2. 当前题身份、学科、真实进度与来源属于阅读定位；不加入虚构统计。
3. 共同材料先于题干，小问的题干、材料与输入在同一语义 section。
4. 作答是可编辑内容，选择行使用原生 radio/checkbox，文本区保持长文输入。
5. 上传列表陈述实际状态，专用答案仅调用批准的安全 renderer。
6. 正常保存是一行辅助文字；冲突展开本地/远端比较与 owner 恢复动作。
7. 提交和继续来自同一 owner 授权动作，只有当前 primary 获实色强调。
8. 揭晓前把握与揭晓后评级分别建区；未知判分不暗示成功。
9. 伙伴承载摘要、真实历史、消息、引用预览和编辑器，各自不同密度。
10. 引用是内容边缘的工具；选择内容、引用成功、移除均由父状态决定。

## 构图和组件职责

正文以约 38 个汉字的行长为上限，正文 16px / 1.85（中文适配），标题 22/28，避免题号大标题挤出题面。整页不将每段装进卡片：阅读为平面，材料用左边线，答案用低调容器与明确边界，结果用结论标记和证据段落。24px 段间距、8px 控件内间距建立关联，正文和侧区之间 32px 分隔。主动作 filled round；上下文 action text；选择为整行；主题为 48px icon target + hover/focus tooltip；伙伴入口为带 icon/标签/展开状态的工作区切换。

宽屏（>=1200 CSS px）正文 + 360px 伙伴分栏；中屏（600–1199）保留阅读轴，伙伴为右侧 modal；窄屏（<600）导航折叠、16px 阅读边距，伙伴全宽底部 sheet，独立滚动与 dvh/安全区。1200 是项目选择，不能将 Android dp 与 CSS px 等同为规范保证。短窗不固定 Composer 到视口底部，让整个面板滚动保留键盘可达性。

## Owned files

仅新增 `src/ui-next/practice-workspace/{contracts.ts,controls.tsx,AnswerWorkspace.tsx,ReadingWorkspace.tsx,ResultWorkspace.tsx,CompanionWorkspace.tsx,PracticeWorkspace.tsx,workspace.css,index.ts,styles.d.ts}` 和本 preflight、同前缀 handoff.md。唯一公开组件 PracticeWorkspace；内部模块不建立第二候选入口。所有类/变量用 un- 前缀并限定 [data-ui-next] .un-pw；父接入 UiNextRoot。
