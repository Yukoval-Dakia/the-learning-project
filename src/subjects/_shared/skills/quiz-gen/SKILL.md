---
name: quiz-gen
description: 学习者明确要求出题、组卷或创建练习时的编排方法。询问建议、普通讲解或口头讨论不启动创作。
---

# 出题与组卷

你负责判断请求的考查点、数量和约束，并在工具循环中完成。先确认已有上下文足够；会改变题目要求的缺项才问。不要把「今天做什么」或解释概念当成出题授权。

## 先复用，再补题，最后组卷

1. 出新题前先 `search_bank` 查目标考查点，按请求收窄题型／难度／学科，摘要不够时用版本化 ref 调 `read_bank`。已有合适且准入通过的题就复用。候选、草稿不称合格题。
2. 缺题用 `author_question(seed_mode="teaching_draft",knowledge_ids,draft)`，一次一道，由你直接写紧凑草稿，无嵌套出题任务。draft={stem_md,response,solution_md?}。response 按形式填写：single_choice 的 options/answer_index，multi_choice 的 options/answer_indices，blank 的 blanks:[{answer,accepted?,numeric?:{value,tolerance?,unit?}}]，matching 的 left/right/pairs（下标从 0 开始），break_tap 的 segments，ordering 的 objects_in_order。首日只选这些确定性形式。工具成功提交就已进入题库待自动准入，不进收件箱、不等确认。回复展示题面并用返回的 bank_path 给出 `[在题库查看这道题](实际路径)`。失败原因如实说明；若模型写了 free 解答题，说明当前无法自动判分，可换一道确定性题，不承诺一直等待就会解锁。
3. 用户要可作答练习／整卷时，只把已准入题交给 `write_quiz({title,question_ids})`，用返回的 practice_path 给出练习链接。同轮新题仍在检查时先交题库链接；组卷成功也不代表题已准入，不能把正文或待检查卷称为可运行练习。

整卷的数量、难度、题型、知识点遵守原话与已有任务；不自行扩大。未覆盖的要求如实说明，不为了凑数塞入不合格题。

## 题目结构

按结构理解题型，不只匹配名字：
- nesting：flat 是一题一答案；nested 是共享材料锚加多道小题，材料要持久化，各小题围绕同一材料。
- layout：条件与所求、原文与转换指令、材料与层次设问、选项与正确项依据等；公式用 LaTeX，renderConfig.notation=katex。
- answer semantics：exact 是确定答案及等价形式；semantic 是开放表述，以 rubric_json.required_points 的可核查要点判分；题组可混合。

实际加载了学科规范包就按其结构坐标与答案格式；未加载则用上述三维推导，不声称读过未提供的规范。

## 失败后

先按学科与考查语义匹配已有节点，命中时沿用对应 knowledge_ids；不把同科但不相关的节点当作合适节点。没有合适节点时，传 knowledge_ids=[]、已有学科 subject_id 和 learner_topic（本轮主题原话的逐字子串），直接提交到学科根，照 placement_note 一句话说明，不问确认、不提收件箱、不提议建节点。先匹配已有学科，主题不是新学科。未登记学科也调用 author_question 并传学科名：学习者原话第一句整句是「我想学/学习 X」这类声明时（整条不超过 40 字），系统会建学科并把题存进去，成功后照 placement_note 说明；否定、转述、引号里的、并列学科（X 和 Y）都不建，否则取得 subject_root_missing，只用人话说明这个学科目前还没有、这次没存题；结果 subject_created=true 但存题失败时如实说明学科已建、题没存，同名重试会回放同学科；不展示问题code或内部结构，不提议也不请求确认创建学科、根或知识节点，不引导去收件箱。可以在对话里讲一道题，但要明确这不会进题库。缺学科是当前能力边界，不重试、不把修复结构变成学习者的下一步。failed 如实说明，可根据原因换种子重试一次，连续失败停止。搜索／生成／组卷各阶段分别报告结果，草稿留下了但组卷失败也要交代，不能说全都没发生。
