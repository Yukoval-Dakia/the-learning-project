---
name: quiz-gen
description: 学习者明确要求出题、组卷或建练习时用。问建议、讲解或口头讨论不启动创作。
---
判断考查点、数量与约束，在工具循环中完成。先核上下文，只问会改题要求的缺项。「今天做什么」或解释概念不出题授权。
## 先复用再补题后组卷

1. 出新题前先 search_bank 查目标考查点，按请求收窄题型／难度／学科，摘要不足则凭版本化 ref 调 read_bank；复用合适的已准入题，候选/草稿不称合格。
2. 缺题用 author_question(seed_mode="teaching_draft",knowledge_ids,draft)，一次一道，由你直接写紧凑草稿，无嵌套出题任务。draft={stem_md,response,solution_md?}。response 按形式填：single_choice 的 options/answer_index，multi_choice 的 options/answer_indices，blank 的 blanks:[{answer,accepted?,numeric?:{value,tolerance?,unit?}}]，matching 的 left/right/pairs（下标0起），break_tap 的 segments，ordering 的 objects_in_order。首日限这些确定性形式。提交成功即进题库待自动准入，不进收件箱、不等确认。存后以 question_id 调 compose_block 放 inline question_ref 题卡，用回执 place 放入回复；正文别提检查、准入或能否作答。失败原因如实说明；若写成 free 解答题，说明现无法自动判分，可换确定性题，不承诺空等即解锁。
3. 要可作答练习／整卷时，把已准入题交 write_quiz，附同次 search_bank 的 search_id、assessments；checks[].condition 填该次 conditions[].id（如 r1），不填条件原文。用返回 practice_path 给练习链接。同轮新题仍在检查时先交题卡；组卷成功不等于准入；正文/待检查卷不称可运行练习。

整卷数量、难度、题型、知识点遵原话及已有任务，不扩大；未覆盖项如实说明，不以不合格题凑数。

## 题目结构

按结构理解题型，勿只看名：
- nesting：flat 为一题一答案；nested 为共享材料锚加多道小题，材料须持久化，各小题围绕同一材料。
- layout：条件与所求、原文与转换指令、材料与层次设问、选项与正确项依据等；公式用 LaTeX，renderConfig.notation=katex。
- answer semantics：exact 为确定答案及等价形式；semantic 为开放表述，按 rubric_json.required_points 可核查要点判分；题组可混合。
已有学科规范包则按其结构坐标和答案格式；否则按上述三维推导，不声称读过未给规范。

## 失败后

先按学科、考查语义找已有节点，不能仅凭同科。无合适节点先 propose_knowledge_mutation 建子节点（自动应用）再照常存题（knowledge_ids=[]、subject_id、learner_topic 不变）；不问确认、不提收件箱。先匹配已有学科，主题非新学科。未登记时仍调 author_question 传学科名；仅学习者首句完整为「我想学/学习 X」类声明且整条≤40字时，系统建学科存题；否定、转述、引号内、并列学科（X和Y）不建。否则返回 subject_root_missing，只用人话说学科暂无、题未存；subject_created=true 存题失败则说明学科已建、题未存，同名重试回放同学科。不展示问题code或内部结构，不提议或请确认建学科、根、节点，不引导收件箱。可对话讲题，但说明不进题库。缺学科不重试，勿把修结构当下一步。failed 如实说明，可按原因换种子重试一次，连败即停。搜索/生成/组卷分报结果，留草稿但组卷失败也交代，不称全未发生。
