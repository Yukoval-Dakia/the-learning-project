---
status: proposed
---

# ADR-0073 — 判分系统：上游存储与标定（含判分方法标定）；系统本身负责按题型展示、收集作答与判断；练习与拍照录入共用同一套

**Status:** Proposed（设计方向，2026-10-11）；尚未实施。
**Decision source:** owner 2026-10-11 三连拍板——14:04「我们要的是选择题“编号”，不是从文本里启发式读取答案……你需要一套完善的判分系统」、14:08「grading system的上游是好的题目存储标定，system本身处理题型展示与答案判断」、14:11「而且上游就要给判分方法做标定」（决定记录 `/Volumes/YukovalSBak/yukoval-projects/tlp-status/decisions/2026-10-11-grading-system.md`）。
**Tracking:** [YUK-1445](https://linear.app/yukoval-studios/issue/YUK-1445)（判分准入）、[YUK-1404](https://linear.app/yukoval-studios/issue/YUK-1404)（拍照录入）。
**Related:** ADR-0069（D8 单一入库闸——答案 spec 与标定随其泛化落地）、ADR-0071（grader 只 fallback 到准入模型）、ADR-0072（题库/判分工具不读学习者状态）、ADR-0068（通用学科）、YUK-1468（备题员）。

## 背景与问题

TEST 实测（YUK-1445 排查）：62 道 active 题中 36 道被判分维度冻结，学习者看到「无法判定」。机制（origin/main 核实）：web/legacy 题的 `reference_md` 原文在 `src/kernel/records/assessment-normalization.ts` 里经答案头解析铸键——选择题头解析不出纯字母（如 `ik0pzw6mqmv3zxptbujdka8b` 的 “B．60°”）⇒ 降为 `rule_reference` + `unrepresentable_answer` issue，publisher 强制 withheld；且 `executorFor` 对 rule 单元只配 `human_review`（「未准入的模型判分能力不冒充」，D17）——即今天既没有键、也没有可执行的判分器。把 “B．60°” 启发式解析成「选项 B」的修补被 owner 否决：编号要的是**录入时明确补齐**，判不了就别出。

契约底座其实已建好：YUK-1046 五层模型（`src/core/schema/assessment/`）——structure（parts+materials，无学校题型枚举）/ response（槽位原语 + stable option_id，missing≠blank）/ scoring（六种判据：`option_set_key.accepted_option_ids`、`matching_pairs_key`、`text_key`（四种归一档位）、`numeric_key`+容差/单位、`rule_reference`、`holistic_level`；分只在 scoring unit 上）/ execution（五种确定性比较器 + `model_executor` 必须携带 `admitted_slice_id`，每 unit 恰好被一个执行器覆盖）/ revision（`PublishedQuestionRevision` 把 1–4 层整体不可变版本化；issuance 冻结 part 集、材料 digest 与 `option_order`）/ judgment（`SubmissionRecord` 冻结作答；`EvaluationRecord` 一致性校验 + 唯一聚合点；显式 pending 家族，绝不伪零分）。缺的是 owner 指出的两件事：**上游没有把答案 spec 和判分方法标定当作入库的必经产物**，以及**录入卷面作答没有逐单元进同一套判分**。本文钉这两个决定。

## 决定

### D1 上游＝题目存储与标定：每题带类型与结构，每个计分单元带显式 typed 答案 spec

每道题入库（ADR-0069 D8 泛化后的单一 commit gate，供给 agent / 录题 agent / Copilot 拟题 / 存量回填四源同门）必须带：题型；结构（小问与空作为 scoring unit、选项带稳定 option_id、图绑定到正确 unit）；每个 unit 的显式 typed 答案 spec，直接用 `scoring.ts` 既有判据——选择 `option_set_key.accepted_option_ids`；填空 `numeric_key`+容差或 `text_key`+声明的等价写法（归一档位显式）；解答每小问 `rule_reference`（规则原文 + 参考解法）/`holistic_level`，只用印出来的分值，无印分则总分未知（契约既有 no_mapping 不造分纪律）。答案 spec 由**录入 agent 用 AI 解题产出**（不是从页面上抄）；**第二次独立解题一致才准入**；页面/来源答案文本只作 cross-check（不一致 ⇒ 拒绝或人工裁决），**永不解析成键**。拍照录入因此不需要页答案键——卷面上有没有印答案与题库标定无关。

### D2 录入时给判分方法做标定（owner 14:11）：每单元冻结方法 + 探针全过才准入

每个计分单元在入库时定下**判分方法**并当场标定。方法 = 判据种类 + 执行器（确定性比较器 id，或哪个已准入 AI 判分切片 `admitted_slice_id`）+ rubric/policy 版本。**标定探针**在准入前跑：判分器必须①认对已核验的参考答案；②认对该题型应接受的等价形态集（填空的替代数值/区间写法；选择题 option_id 在 shuffle 服务序下仍判对——作答收的是稳定 id 不是位置）；③判错生成的典型错答（含近似错与**该题常见错法**）。解答题再加两形态：按政策正确处理「答对但过程有纰漏」「自己划掉的错步」（明确划掉的步骤不算瑕疵）。探针集由录入 agent 生成，并**先于标定运行冻结 digest**、不许看完结果再挑；核验者独立：typed 判据（选项/文本/数值）探针的期望判定由确定性检查机械核验，rule/holistic 单元与错答探针的期望判定须经独立 pass（与 D1 第二次解题同一独立性要求：隔离上下文、互不见对方输出；是否跨模型族留待 owner）确认后方可冻结。**结果**：全过才 `admitted`，随准入证据冻结方法与标定记录（方法、各版本、探针 digest、逐条结果）；任一失败 ⇒ 该题不出，带 reason，供给/录入侧可重试或拒绝。版本变更分两类：切片 id、rubric 文本或判据内政策变更属**冻结内容变更** ⇒ 铸新 revision（supersedes），准入证据随新 revision 重走；仅执行器实现细节或标定证据刷新、内容 digest 不变 ⇒ `admission_updated` + generation CAS。两类都不改写旧 Judgment。单题标定与「每科 ≥30 道留出题」的模型级准入**两者都要，互不替代**：后者证明该模型在该科目整体可用，前者证明该方法对**这道题的这个单元**可用。

### D3 承载：扩展既有冻结面，不新建第二套记录

方法即 `execution.ts` 的 `ExecutionPlan`——它已随 `PublishedQuestionRevision` 整体不可变版本化并进 `integrity_digest`；标定探针经**同一个** `evaluateSubmission` 纯内核跑（对合成 ResponseSet 判分，模型执行器走既有注入 port 与 claim/result 记账），不建第二判分路径。标定记录是**准入证据的扩展**而非新记录：`PublishAdmission.evidence`（已含 `marking_provenance`/`verification`/`model_slice`）扩 `calibration`（方法指纹、探针 digest 与结果），append-only 落 `question_admission_verification`。重标定时内容 digest 未变 ⇒ **不铸新 revision**，走既有 `admission_updated` 事件 + generation CAS（`assessment-publication.ts` 已有该轴）。旧判分按其 `plan_digest`/`run_refs` 审计（task_run 侧 provider/model NOT NULL，判分记录始终可追溯到实际执行的 grader 与模型）。

### D4 判分系统本身：按题型展示收集、按冻结方法判、结果与过程两轴、判不了不出

**展示与收集**按类型：选择题收 option_ids（呈现按 issuance 冻结的 `option_order` 服务序，`dto.ts` 投影已实现）；填空逐空；解答逐小问收过程文字 + 照片（open_response 证据）。**判断**按冻结方法：编号、数值容差、声明等价写法、配对走确定性比较器（五种已在线）；rule/holistic 与语义等价个案交已准入 AI judge。**结果与过程是分离字段**，过程瑕疵绝不扣结果分。`EvaluationRecord` 不可变并署名实际执行的 grader 与模型（plan_digest + run_refs）；判不了是显式 pending（`unjudgeable` 等），绝不伪零分。判分政策逐条落点：蒙对得满分但只算弱掌握证据（assisted/弱证据纪律已在 settlement）；多空逐空计（每空一个 unit）；单选/单空精确语义匹配、接受等价形态、无部分分；多选全对才对、无错子集=partial 且**分数未知不造分**、含错即错；解答逐小问、小问内部分分需 stated reason、只用印出来的分、无印分总分未知；未完成作答计 0 分并记能力；无作答=仅题目，不写 attempt（unanswered 路径已有）；明确拒绝的步骤不算瑕疵。结果准入与过程证据准入是**分离的门**——过程输出未过自己的 bar 前只算弱证据。

### D5 服务门：单元级方法齐备 + 判分器可用 + 材料齐才发题

复用并收紧 `issueAssessment` 的 `auto_score` 门（现查组级 `scoring_admission_state`，非 admitted ⇒ `not_admitted`）：**发出的 part 范围内**每个 unit 都有已通过标定的方法才可发（范围外/未发出的不可判单元不阻塞，与 `issueAssessment` 的 `part_ids` 作用域及 #1677 的按发出范围判定对齐；作图等不可判小问独立成 part 时按单元扣发，混合卷不因一题扣留整卷失败）、判分器当前可用（确定性比较器恒可用；模型切片在线且未冷却，ADR-0071 链上无准入条目 ⇒ withhold）、题干引用的材料全部在场（题干提到图而图缺失 ⇒ 不发；`validateIssuanceBinding` 已强制发出 part 的材料全绑定）。capture 回执豁免语义保留：已发生作答的收据可以绑定 revision，但出分/入账仍要求 admitted。

### D6 两个入口一套判分：练习作答 + 拍照录入卷面作答

练习：学习者在 app 作答，走 issuance→submission→判分。拍照录入：页面含学生作答时，录入 agent **逐单元如实读出**——圈了/写了哪个选项（→option_ids）、每空内容、过程、红笔按学习者偏好解读（**事后订正单独记录，绝不冒充作答**）、无法辨认 ⇒ unknown（pending）。capture 经**既有作答写入器**（`captureIngestionOriginal` → `saveSubmission`/`commitFormalAttempt`）进**同一套**判分系统、同一冻结方法与政策；录入侧没有第二套判分逻辑。现状缺口（代码核实）：今天 capture 只把 flat `wrong_answer_md` 映射进单一槽位、选择题靠 label 大写匹配——这正是要被逐单元结构化 capture 取代的启发式；`enroll.ts` 的 outcome-as-signal 旧路径退役为「无判分面时的材料录入」。录入模型同一次调用顺带给的判分意见，**只有**按判分系统契约输出、且该模型/切片对该单元已准入并标定才算数，否则一律 advisory。因此 YUK-1404 录入对比测的是 capture/handoff 正确性；判分质量归本 ADR 所有。

### D7 按题型的判分方法（owner 2026-10-11 14:19）

owner 原话要点：「需要过程的就走ai判定嘛，把评分细则交给agent就可以。数学填空，可以用Jev类型的决策模型，解决数值问题。单纯的判断相等（一个或多个允许的答案），那就是英语填空。选择题就是选项……要支持多选题。如果用户提交了note/过程，那就应该会触发某个agent的分析了。语文阅读……和简答题一样。语文诗词填空……出题记得分段到句，句内错别字怎么判……」各类型冻结方法如下（D2 标定照常适用）：

- **选择（单选/多选）**：`option_set_key` 编号比较器，多选按 D4 政策；不读题面文本。
- **「一个或多个允许答案」的相等判断**（如英语填空）：`text_key` 允许答案列表比较器，规范化只限声明的大小写/空白/全半角；拼写变体（英/美）须入库时列入允许列表。
- **数学填空**：两侧均为纯数值时走 `numeric_key` + 容差快路径；否则（分数/根式/区间/表达式等价）交 Jev 型类型化决策模型（`src/server/ai/typed-primitive-runner.ts` 的 typed decision lane）输出「等价/不等价/无法判定」，该判分器同样过 D2 标定（等价写法认对、典型错答判错）与 ADR-0071 准入门；无法判定 ⇒ pending，不造分。
- **解答 / 简答 / 语文阅读**：准入 AI judge + 入库时写好的评分细则（`rule_reference`/`holistic_level`，逐小问、印分规则见 D4）。
- **诗词默写**：出题按句切成计分单元；判分为确定性逐字比对（规范化标点/繁简；允许的通假/异体字须入库时写入允许列表），**句内有错字即该句不得分**并标出错字位置（协调线建议，owner 可改为按字扣分）；决策模型只用于录入侧手写字形辨认的歧义（属 capture，辨认不了即 unknown），不用于判分。
- **任何题附带学习者笔记/过程**：触发过程分析 agent，产出瑕疵/能力只进过程轴（不改结果分），过程证据准入前标 unverified、只作弱证据（D4）。
- **真实卷题型清点补充**（owner 14:30 提供的浙江高二上九科试卷，清点只记结构，见仓库外 `tlp-status/discussions/zj-g11-question-type-inventory.md`；该批卷为判分准入留出候选，不用于调提示词）：
  - **部分分规则逐题存**，不按科目推定：同为多选，物理「全对 4、漏选 2、错选 0」，数学只写「部分选对得部分分」不给数——后者部分分 = 未知，不造分；语文断句「每对一处 1 分、超 3 处 0 分」这类规则须入库时写进该题评分规格。
  - **不定项 / 答案个数未告知**的选择与填标号题（物理多选、化学 18(2)、生物 21）仍按选项编号集合判；个数不作提示也不作判分前提。
  - **组合选项（①③）与图片选项**仍是选项编号，判分不读选项内容。
  - **选做题**（语文 22）：计分单元按学习者所选分支实例化，未选分支不计。
  - **作图题**（物理连线/描 U-I 图、生物画柱状图）当前**不可自动判** ⇒ 该单元无准入方法，按 D5 不出（或整题仅作材料录入），直到有经标定的作图判分方法。
  - **作文**（分档 + 固定扣分项：标题、错别字、标点、字数）与**史论短文**（分维度）走准入 AI judge + 入库评分细则，档位与扣分项逐项记录。
  - **数值/表达式/离子方程式/平衡常数表达式/基因型与概率**走 D7 的类型化等价判断，须覆盖小数位、单位、开闭区间等价。
  - 录入侧发现（属 capture，不属判分）：多数 PDF 为图片无文字层、英语为歪斜扫描；docx 中解答题题干是内嵌图片、源文件本身有题号错乱——录入须读图且如实标注源缺陷，不得据此补造题面。
- **呈现**：含共享材料的题（语文阅读、英语完形等）文章常驻左、题在右，不上下堆叠（owner 14:19，归 UI/Opus 线与设计规范）。

## 硬边界（后果）

1. **零文本解析键**：reference/页面答案文本永不铸键，只作 cross-check（验收项；`reference_md` 头解析铸键（含 `answerFromRowReference` 兜底）不再服务新题，存量经回填收敛后退役）。
2. **未标定不出**：任一 unit 无已通过标定的方法 ⇒ 整题不进 `auto_score` 服务面；不存在「先发再转人工」。
3. **单一判分逻辑**：ingestion 无第二判分器；不满足契约+准入的录入判分意见只是 advisory。
4. **旧 Judgment 永不改写**：换判分器/模型/规则版本 ⇒ 重标定 + 新判分；历史按原 plan_digest 审计。
5. **判不了=显式 pending**：不伪零分、不造总分（no_mapping 纪律）。
6. 单题标定与每科 ≥30 留出题模型准入**互不豁免**。
7. ADR-0071 fallback 只到准入模型；ADR-0072 判分/标定读取不碰学习者状态；§9 八项承重（含不可变 Judgment 与确定性选题 seam）不动。

## 分阶段交付（owning lines）

1. **feature（YUK-1445 判分准入线）**：entry 答案 spec + 方法标定（四源同门，`store_sourced_question` 泛化随 ADR-0069 D8）、确定性判分器补齐、rule/holistic 的 admitted AI judge 切片、服务门收紧到单元级；**migration 线**：标定探针 job、版本变更重标定 job、存量回填 job 的 DBOS/pg-boss 接线与 schema 迁移。
2. **UI（Opus only，练习/录入线）**：按题型展示与收集（选项服务序、逐空、逐小问过程+照片）与诚实状态（未作答/无法判定/总分未知）。
3. **存量回填**：现有 active/draft 题经同一入口补答案 spec + 标定；保留原 history（新 revision `supersedes`，旧 revision/判分行不动）；不 regex 解析；交付覆盖率报告（回填前后可服务题数对比）。

## 验收

- 确定性判分：invariant 测试（五类之第 2 类——同输入同分/同状态）。
- AI 填键与 AI 标定：real-provider actual-output 封存（exact revision、输入/输出 digest、task-run ID、provider/model/cost），报二次解题一致率与标定探针通过率。
- 服务门：隔离 TEST 副本上证明——未标定单元/缺图/判分器不可用的题均不外发，已标定题正常服务且 36/62 类「无法判定」不再出现于已发题。

## 被拒绝的备选

- **从答案文本解析键**（“B．60°”→选项 B）：owner 否决（14:04）——编号必须录入时明确补齐，不靠启发式。
- **先发题再转人工复核**（现状 36/62 机制）：把不可判伪装成已服务，学习者看到「无法判定」——被 D5 单元级门取代。
- **一个 AI judge 包打一切（含选择题）**：编号/数值/声明等价是确定性事实，AI 判贵且不可复现——确定性比较器优先，AI 只判需要理解的单元。
- **录入内置第二套判分**：两套逻辑必然漂移——被 D6 同一套取代。
- **不做单题标定就准入**：模型级准入不针对具体题目，探针拦得住的错判它拦不住——被 D2 取代。

## 未决问题

- 标定探针集的最小规模与「该题常见错法」的生成纪律（初值：每 unit ≥2 等价形态、≥3 错例，随第一刀实测定）。
- 判分方法版本指纹的构成（比较器版本、`JUDGE_PROMPT_TEMPLATE_REVISION`（现 `judge-prompt-v1`）、rubric 版本如何合并为单一指纹触发重标定）。
- 多选「无错子集=partial 且分数未知」的证据口径：不造分已定，是否记弱掌握证据随第一刀实测。
