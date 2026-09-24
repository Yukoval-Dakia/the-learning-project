# 全量题目契约迁移 — implementation grounding

2026-09-24 · YUK-1038 · 状态：source-only grounding 完成（lane A/B/C/D 已归并）；产品决策与证据缺口仍开放，不能作为已完成实施 spec，未执行实施/迁移。

## Owner 裁决与本轮范围

「不错的模型。不分批了，要上就全量迁移，支持任意题目。详细的 impl grounding 做一轮。」

- 采用[五层模型方向](2026-09-24-question-assessment-redesign.md)：题目结构、作答要求、评分依据、执行计划、判分记录。
- 旧 LIGHT/LIGHT-1 分批产品切换建议已被取代；要求全部录入/消费路径、历史数据统一迁移后一次切换。
- 允许工程依赖排序、离线演练和切换前校验，不把这些包装成部分题目先上线。
- 任意题目不是有限学校题型枚举；通用复合结构、响应原语、开放作答/原始证据与评分契约须可表达。材料缺失或不能可靠判分必须有明确未决态，不能靠伪零分实现“支持”。
- 本轮只做源码调查与实施规划，不执行代码实现、schema/data migration、生产访问、付费模型评测或部署。
- “全量迁移”与“重判全部历史作答”不是同一动作；历史事实缺失不得补造，具体处理须落到映射与验收契约。

## Task plan（接续既有研究，不重置之前任务）

1. [x] 真实试题/官方评分规则调研与模型提案。
2. [x] 独立架构复核、归并正确性约束。
3. [x] 记录 owner 全量迁移裁决，停用 LIGHT-1 推荐。
4. [x] A — 存储、主要录入/编辑/发布路径源码 grounding 返回并归并（implementer / imp-2，只读；尚非运行时普查）。
5. [x] B — 判分执行、模型契约与测试设施 grounding 返回，已补查 Jev typed HTTP 接缝（implementer / imp-3，只读）。
6. [x] C — 历史迁移、在途状态、复判/学习投影、统一切换与回滚 grounding（oracle / ora-1，只读）已返回并归入 §8–§16。
7. [x] D — 作答/查看/录入交互与公开接口、设计 preflight grounding 返回并归并（designer / des-1，只读）。
8. [x] 主会话整合：归并 source-of-truth、身份映射、模块 Interface、文件清单、依赖图与未决裁决（§3–§5、§17）。
9. [x] 形成可执行验证矩阵与全量切换/回滚 runbook（§6、§15–§18）；证据缺口已显式列出（§19/状态与证据缺口），不宣称通过。
10. [x] Linear capture 与本地规划提交收口（PLAN/术语/handoff 已对齐）；不自动启动实施或推送。

## 调查输出契约

每条 lane 的当前行为结论必须有实际文件/符号/行号，不以注释、类型 enum 或搜索片段代替 live consumer 证明。提出的设计与代码现状分别标记。

每项改动写明：调用者、写入/读取真相源、所需新旧字段/事件、错误态、并发/幂等、必须保持的不变量、scoped 自动测试和需要实际模型/浏览器/数据库演练的部分。

## 验证主张与 owner

| 主张 | 调查/证据 owner | 本轮可建立的证据 | 实施后才可建立的证据 |
|---|---|---|---|
| 无遗漏的主要 producer/edit/publish 接口 | A，主会话归并 | writer/reader矩阵、schema和测试定位 | 全来源契约测试、迁移后无旧写路径 |
| 通用响应/评分契约可执行而非只可存储 | B + D | runner/DTO/UI能力矩阵、未支持状态清单 | 端到端真实作答与留出集 actual-output |
| 历史数据与学习语义不丢不重复 | C | 身份/事件/投影消费者与迁移策略 | 隔离restore演练、row/edge/hash清单和并发故障注入 |
| 全产品统一切换且可回滚 | C，主会话归并 | app/worker/cron/在途会话切换方案 | exact-head发布演练，切换前后写入回滚证据 |
| 不泄露评分私有信息，交互状态诚实 | D + B | DTO路径、候选/生效结果读取清单 | 浏览器、鉴权、未决态与多模态验收 |

基线：源码 `f804554e6`，文档 branch `docs/yuk-1038-assessment-redesign`。尚无本轮生产库存 census、迁移演练、模型 actual-output 或全产品浏览器证据。不得拿旧日期的库存数字或旧 CI 当本轮证据。

## 1. 已核实的存储与身份基线

本节来自 lane A 的直接源码核查；路径均为仓库相对路径。规划是建议，不是已执行 DDL。

| 现状 | 实际位置 | 全量迁移影响 |
|---|---|---|
| `question` 可变列持有 prompt/reference/rubric/choices/structured/figures；choices 是位置数组 | `src/db/schema.ts:406–503` | 不能把添加 revision 字段当迁移完成；所有内容 writer 要收敛 |
| `question.version` 是乐观锁，不是完整版本历史 | `src/server/questions/write.ts:348–373` | 不能从一个 version 数字恢复历史学生所见 |
| physical part 是独立 question 行，具有 parent/part_index | `src/server/questions/parts.ts:108–148` | 保留旧 question 身份及调度引用，不按显示序号重铸 |
| structured part 是 jsonb 中的节点 ID，`part_ref` 指向它 | `src/capabilities/practice/server/judge/narrow-part.ts:12–17,75–104` | 和 physical part 不是同一维度；当前 narrowing 会裁掉兄弟题，联合判分必须改 |
| quiz_gen 把 structured ID echo 到 physical part metadata | `src/capabilities/practice/jobs/quiz_gen.ts:1397–1399` | echo 不是受约束外键，不能据此保证历史映射 |
| 归一化可能重建 tree ID | `src/core/schema/question_author.ts:90`；`quiz_gen.ts:849–895` | 重抽取不能直接覆盖已经发出的身份映射 |
| `question_block` 是 event-sourced 草稿；question 内容目前 imperative | `src/server/projections/sot-flag.ts:6–14`、`entity-registry.ts:114–181` | 本次不把 question 全面改为另一套 fold；复用现有草稿事件和发布服务 |
| paper `answer` 带 part_ref、文本和图片；未提交槽有部分唯一约束 | `src/db/schema.ts:868–894` | 新响应集合要保留历史 carrier 及草稿恢复，不只改 submit DTO |
| 已有生成 answer anchor/plan/binding | `src/db/schema.ts:239–339` | 作为来源/验证证据引用，不复制为第二答案真相 |
| durable judge 已冻结 question/profile/body | `server/judge-run-payload.ts:103–165`；`src/core/schema/event/judge-pending-events.ts:47–107` | 沿用恢复基础设施，增加明确 revision/submission 引用及完整性校验 |
| 当前 canonical fingerprint 会归一空白并把图片 URL 替换成 IMAGE | `src/capabilities/practice/server/quiz/content-fingerprint.ts:43–60,83–99` | 只能用于内容相似/去重，不能证明实际判分输入完全相同 |

`server/...` 简写在判分表中指 `src/capabilities/practice/server/...`，除非显式写 `src/server/...`。

## 2. 全部主要 producer / edit / publish 改动矩阵

下表不是上线批次；所有行都是统一切换覆盖清单。测试路径在实现时按仓库实际位置确认，不能从文件名推断 unit/DB 分区。

| 来源/操作 | 当前落库与发布位置 | 必须改的契约 |
|---|---|---|
| OCR/VLM + 自动收录 | `ingestion/server/auto-enroll.ts:757–865`，结构/KC门控制 active/draft | 原始抽取/学生作答/参考答案分离；创建 revision 与使用范围；judge 也走统一 evaluator |
| 上传确认导入/手工改题面/合并块 | `ingestion/server/import-completion.ts:346–390`；`import.ts` | 当前编辑可使 structured 被丢弃；迁移后保留原件/变换依据，无法结构化时使用通用开放作答契约，不丢内容 |
| question_block 编辑/拆分/合并/配图归属 | `src/capabilities/ingestion/server/block-structured-edit.ts:163–217,229–764` | 保留原有 fold/genesis；编辑 working copy，发布才原子生成新 revision |
| web/jyeoo 来源 | `practice/server/tools/store-sourced-question.ts:157–388` → `src/server/questions/sourced-draft-insert.ts:85–229` | 去重/KC合并/来源 extract/资产守卫保留；统一草稿规范，verify 对 revision 而非可变行 |
| 批量 quiz_gen、复合题、tool_quiz | `practice/jobs/quiz_gen.ts:1244–1289,1351–1405,1439–1470` | 题组 revision 与 part identity 一起写；artifact 引用稳定身份，实际 serve 绑定版本 |
| quiz_verify/source_verify/人工 promote | `practice/jobs/quiz_verify.ts:739–914`；`source_verify.ts`；`verify-and-promote.ts:249–270` | 原锁序/版本守卫/tombstone 保留；改成 revision-scoped verification 与 admission generation |
| author_question + question_draft 接受/拒绝 | `practice/server/tools/question-author.ts:283–345`；`src/capabilities/practice/server/proposal-appliers.ts:342–623` | draft+proposal事务不拆；接受进入统一发布；拒绝不得被异步verify再次激活 |
| generate_question_candidate | `practice/server/tools/generate-question-candidate.ts:50–80` | 目前不持久化，仍不冒充已发布题；返回候选契约给真实保存者 |
| mistake_variant 接受 | `proposal-appliers.ts:253–274`；variant_gen/variant_verify | 保留血缘；接受→revision/admission，不能绕发布直接 active |
| 人工错题 | `practice/api/mistakes.ts:101–117` | 原错误作答证据不能成为答案键；题目契约与初次学习事实分别保留 |
| image_candidate 接受 | `src/capabilities/ingestion/server/image-candidate-accept.ts:836–922` | 保留 terminal-rate 锁/来源图证据；后续 verify 撤销资格不丢已提交答案 |
| legacy dreaming proposal | `src/capabilities/ingestion/server/legacy-record-appliers.ts:360–382` | 仍可读历史；可达接受路径必须生成新契约，不能成为漏网写口 |
| seeds / scripts | `scripts/seed-synthetic.ts:291` | seed 也生成完整 revision；synthetic 标识保留，不能靠审计豁免漏迁 |
| teaching_check | `copilot/server/teaching/materialize-ask-check.ts:49–98` | **container-only 不免迁**；教学turn与revision/issuance原子绑定 |
| conjecture probe | `agency/server/conjecture/probe-lifecycle.ts:204–260` | probe spec/claim版本与当次发题绑定；相同文本不同probe occurrence不能被去重掉 |
| intervention diagnostic | `practice/server/intervention-diagnostics.ts:294–385` | immediate/delayed/transfer及教学材料版本纳入冻结上下文；一次性claim与题目审核状态分离 |
| 已发布题平面/结构化编辑 | `src/server/questions/write.ts:207–377`；`acceptQuestionEditProposal:786–960` | 修改 working copy→新revision；原question平面列变投影，禁止绕发布直接改 |
| archive / 恢复 / retraction | `write.ts:391–497`；proposal appliers | 生命周期资格与内容revision分离；释放live去重claim，不清除历史摘要/绑定 |
| reference_answer_backfill | 同名job/DB test | 生成参考答案也影响评分依据，必须新revision+来源标识，不能直接改已发布列 |
| answer_class / embed / difficulty / supply metadata backfills | 同名jobs、answer-class-write.ts:44–80 | 明确哪些只是检索投影、哪些改变判分输入；后者走新版本，前者不能悄悄影响旧attempt |

实现文件表须把表内模块短名解析为实际路径；不得照抄未经核对的路径创建平行模块。主要写口之外，implementation gate 再做 insert/update 闭包检索和审计，证明无漏网 runtime writer。

## 3. 统一真相源、状态与身份（归并后的推荐）

### 3.1 发布与版本

- 保持一个编辑事实来源；既有 question_block 与题库编辑入口是不同工作流程，通过统一 normalizer/publisher 形成同一种不可变发布表示，不同时维护两棵可独立修改的发布树。
- `question_revision` 属于 group root，单题是1-part组。唯一键是 `(group_id, revision_ordinal)`，不是全局内容hash。版本化完整性digest包括材料/资产digest、内容、作答契约、评分依据及执行计划的明确引用。
- physical question 行保留现有 ID，成为身份/检索/KC/当前发布坐标投影；不要为合并结构而重建旧调度身份。
- 新revision、current pointer、compatible projections与发布事件同事务提交。**在发题时**绑定 revision、目标part、实际材料和选项展示映射；不能提交时再取latest。
- part/slot/option/criterion身份在语义不变时保留；拆分/合并/语义替换明确生成新身份与映射，禁止按label/数组index/相同文本自动认定连续身份。
- 旧平面列可保留作只读投影和回滚资产；全量切换后无原始内容双写口、无新runtime fallback猜旧路由。

### 3.2 去重与历史映射

不可变 `revision_digest` 永不因archive改变。live去重键/作用域保留在可变题目生命周期权威，独立版本化；archive释放claim，暂时verify挂起不默认释放claim。恢复要原子重新取得claim并处理冲突。

历史映射按**原始记录发生上下文**识别：`mapping_id`主键，`UNIQUE(source_kind, source_id, source_locator)`，locator非空；另记原question_id、可空legacy part_ref、已知snapshot digest、target revision/part/slot、映射证据/算法版本/状态。不存在的历史digest保持未知。

不使用 `PRIMARY KEY(question_id, nullable_part_ref)`：PK不能包含NULL，而且即便用空字符串也不能区分同题不同历史版本。映射修正保留历史，不覆盖先前依据。未能恢复的旧记录进入新系统原生 `historical_unresolved` 表示，仍可查看原始证据，不能拿当前题面补造成当时所见。

### 3.3 资格与使用范围

分清：revision存在 / 评分准入 / general-pool或container-only / issuance与一次性claim / suspended或withdrawn。当前 `draft_status` 同时表达未完成和容器内可用，迁移必须拆开意义。

teaching/probe/intervention 的 revision 与容器occurrence同事务绑定；不需要入公共题池才能拥有可用版本。intervention含教学材料时冻结教学包，而不只冻结probe题干。

`source_verify` 当前两种active→draft分支见 `source_verify.ts:525–559,703–730`，验证版本守卫见`:642–656`。新verify保存 `(revision_id,digest,policy,generation)`；旧验证可留证据，不能改变新revision或较新admission决定。

| verify挂起时点 | 新系统行为 |
|---|---|
| 尚未发题 | 禁止新issuance，包括已选入纸卷但未发出的槽 |
| 已发题正在作答 | 保留原版本、答案草稿并提示挂起；不换题 |
| 挂起后提交 | 接收并持久化证据，pending review；不以普通422丢作答 |
| 已排队/正在评估 | 可以保存candidate，activation重新核对admission generation |
| 已经生效 | 保留历史与学习状态、标待复核；不自动撤销 |
| 同版复核通过 | 通过相同幂等/CAS恢复，不重复学习结算 |
| 发布修正版 | 新revision；历史提交仍绑定原版，跨规则复评显式声明依据 |

发题/激活与verify状态变更串行化或CAS；模型调用不在锁内。一次性claim到期恢复不得复活被verify撤回的题。

## 4. 现有判分链与统一执行方案

### 4.1 当前真实 runner（不是 profile 声明列表）

`JudgeInvoker.invoke` 在 `practice/server/judge/invoker.ts:162–356` 依次narrow、resolver、执行/日志，`:358–432` 用if-chain绕过部分registry stub；generic registry router不是模型执行的真实入口。

| 当前runner | 实现 | 必须替换的计分假设 |
|---|---|---|
| exact V2 | `src/core/capability/judges/exact.ts:55–185` | 只有0/1；保留集合/文本比较能力，按发布policy给部分分 |
| keyword | `core/capability/judges/keyword.ts:34–99` | substring命中占比+固定0.85/0.4；不能当通用语言理解 |
| semantic | `practice/server/judge/question-contract.ts:289–409` | 单一holistic score及固定clamp；改为评分单元/等级+证据，不能改名冒充已完成 |
| steps | `steps-judge.ts:109–349` | 固定步骤/答案权重与信号列表；不能表达所有过程分/替代解法/依赖规则 |
| multimodal_direct | `multimodal-direct-judge.ts:101–294` | 单一holistic verdict；要支持跨小问证据及probe signature契约 |
| unit_dimension | `core/capability/judges/unit_dimension.ts:54–113`、`unit_dimension/score.ts:8–106` | 保留mathjs数值/单位检查；固定1/0.7/0.4/0.3梯度降为历史政策，不做新题默认 |

`rubric/ai_flexible` 只是目前未实现的声明，`question-contract.ts:50–53` fail-closed。新系统不保留“声明了但实际没有runner”的假能力。

### 4.2 所有权威评分入口必须一起切换

| 入口 | 当前seam | 统一改动 |
|---|---|---|
| solo同步/attempt | `api/submit.ts:360–564,876–986` | required issuance/revision/submission；统一evaluate/accept/settle |
| durable | `server/judge-run-dispatch.ts`、`jobs/judge_run.ts:73–394` | 冻结新契约、保持原幂等/terminal恢复；无旧resolver重投 |
| paper | `server/paper-submit.ts:349–626` | 多slot响应/联合evaluation group，paid claim与once-only保留 |
| solve tutor | `server/solve-session.ts:307+` | 同一提交与评分契约，不另建评分系统 |
| appeal/rejudge | `jobs/rejudge.ts:95–394` | 改读冻结submission（文本、图、part、版本），不用current row+text-only；所有题型同一evaluator |
| conjecture probe | `agency/api/probe-answer.ts:110–345` | 保留诊断签名与partial/unsupported安全语义，复用新版结果 |
| ingestion grading | `ingestion/server/auto-enroll.ts:112–138` | 当前直接调vision；统一切换时必须纳入，flag关着也不是豁免 |
| advice预览 | `api/advice.ts:73–117` | 签名绑定revision/submission digest/完整candidate；预览不生效不更新学习 |

**不是学生评分的调用不能机械删除**：`src/server/quiz/verify-framework.ts:979–1246,1383–1528` 的solve_check/teaching_quality与source-grounding验证保留异源/否决/来源语义，只把输入改为统一revision契约。问题质量验证与学生得分是两条业务链。

### 4.3 新 Interface（推荐语义，不是已存在函数）

```text
publishQuestionGroup(draft, expectedCurrentRevision, admissionEvidence)
issueAssessment(questionOrContainerOccurrence, requestedParts)
saveSubmission(issuanceId, responseSet, idempotencyKey)
evaluateSubmission(submissionId, evaluationGroupId, executionPolicy)
activateEvaluation(evaluationId, expectedEffectiveId: null | id)
```

发布/存储Module归`src/server/questions/`；判分Module归practice现有judge/settlement seam；TypeSafe传输归`src/server/ai/`；core只放科目无关schema/确定性计分原语。所有route/job/tool仍由已有capability manifest贡献，不创建新平台。

外部调用者不需要知道具体runner和重试方式；Interface必须说明不可变输入、错误态、并发前置条件、取消、费用和无重复学习效应。`activateEvaluation`读持久化candidate，不信任客户端传来的评分对象。

- `revision_id / submission_id / evaluation_group_id` 对新runtime必填；历史未知是另一种显式记录类型，不用可选字段让新请求逃避冻结。
- 一份submission可以有多个evaluation attempt，重试身份和学习事实身份不同。幂等键相同但答案/附件/revision不同返回冲突。
- `expectedEffectiveId` 必填：初次为null，替换为明确旧ID，禁止省略当无条件覆盖。
- 接受并学习结算的事务/恢复方式由§迁移与投影方案确定；candidate与shadow永不进latest-judge显示通道。
- 运行时发布plan是评分语义权威；profile配置给未来规划默认值，不能静默覆盖已发题plan。服务可因模态/故障/低置信升级执行器，但不修改给分规则。

### 4.4 评分单位：避免重复记分

**response slot是作答位置，不是计分权威。** 采用一组唯一`scoring_unit_id`表达答案键、得分点或等级维度；每个单元显式引用其需要的多个slot/材料/证据，贡献分数恰好一次。slot状态、按小问小计、作文维度显示均为投影。

不得同时累加 slot.points + criterion.points + dimension.points，也不得要求“每个关联slot都承担该criterion的全部分”。合计由发布聚合policy选定唯一评分单元，执行sum/cap/weight/档位校验；非加法整体等级用明确映射，未提供映射不凭空制造总分。

题目定义依赖/替代/带错续算语义，模型只能报告符合哪条规则及其证据，不能在输出中新增依赖图/权重。复杂规则可原文+高级LLM联合判断；不为全部考试构建通用DSL。确定的硬不变量仍由代码校验。

空白、未提交、格式无法解释、缺证据、基础设施失败、需要复核分别表达。只有**完整提交且评分政策明确**时空白可得0；missing或识别失败不能变0。模型概率/置信度/期望值与学生分数彻底分离。

## 5. Jev 的真实技术落点

### 5.1 为什么不能只加一个模型名

源码：`src/server/ai/runner.ts:425–552,697,763–880` 从输入生成prompt→prepared query→pi adapter；`execution-adapter.ts:204–216` 当前pi-only；`src/ai/task-spec.ts:44` prompt必需，`task-catalog.ts:9–10`校验非空。Jev `/v1/systemone` 的`state+questions`类型化评估不是这个chat协议。

**推荐一个受限的typed执行入口，复用生命周期，不扩大chat adapter**：新增`src/server/ai/typed-primitive-runner.ts`（或同等专用TypeSafe命名），内部使用现有 `AiRunLifecycle`，只接受注册的typed task，不暴露通用HTTP代理/动态任务端点。

### 5.2 必须接上的现有设施

| 设施 | 可复用源码 | 必须补的内容 |
|---|---|---|
| provider/model/credential解析 | `providers.ts:508–608`；`run-lifecycle.ts:188–199` | TypeSafe server-only配置；明确execution kind，不能全局override到不兼容chat模型 |
| admission/取消/超时 | `run-lifecycle.ts:203–209,290–419,603–615` | fetch连接AbortSignal；总时限覆盖重试及高级fallback，不只每次调用超时 |
| run started/terminal | `run-lifecycle.ts:425–469,520–550,623–668`；`log.ts:258–293` | 保持task_run与cost attempt记录及恢复/终态约束 |
| retry/error taxonomy | `run-lifecycle.ts:680–709`；`agent-run-error.ts:36–97` | typed HTTP status映射；401/422不盲重试，429/529/transport在总预算内；避免SDK+runner+queue重试相乘 |
| cost truth | `attempt-cost.ts:30–90`；`pricing.ts:46–48` | TypeSafe版本化input-token费率；output免费；本地计算标estimated非reported；失败未知费用不当零 |
| input/output provenance | lifecycle input_hash；`persistJudgeRunDigests` | canonical typed body/model/criteria的fingerprint；不调用生成式system-prompt hash假装它是chat |
| schema/census/audits | task-spec/catalog、`audit-structured-judge.ts:48–59` | typed TaskDefinition判别式；输入/输出直接schema解析，不走自由文本JSON extraction |

推荐pin官方核实的direct API版本`jev-1.13.0`，不采用别名或截短未经核实的`jev-1.13`。原方案供应商文档来源见research文档S9/S10；本轮不读取密钥、不作付费调用。

**不是宣称现有生命周期已经证明满足所有付费预算门**：实施前核对typed路径是否实际执行budget reserve/maxCost、usage、取消未知费用与fallback累计上限，补scoped测试；API rate limit/provider concurrency不是美元预算的替代。

无凭证/未准入语言切片时不发送Jev请求，转已批准高级执行器或明确未决；启用Jev的条件是该语言/能力切片actual-output通过，而非原题看起来短。全量契约迁移不靠保留旧runtime支持未准入Jev题。

### 5.3 替换与保留边界

旧resolver/override/路线枚举仅在迁移分类和历史payload解释器中保留；新runtime不走。固定unit/keyword/steps数值政策仅作为带版本的历史解释，不成为新题默认。

保留：确定性比较能力、调用真实发生后才标model-backed的规则、来源验证、诊断一次性claim、事件日志、原有授权预算、安全校验。V1双份judge和无生产consumer的generic router可在对应测试迁移后删除，不把“统一”做成确定性能力削弱。

## 6. 已定位的验证入口（未运行）

- schema/producer：`question_author`、`quiz_gen_plan`、`structured_question` scoped unit；`quiz_gen.test.ts`、`quiz_verify.test.ts`、`source_verify.test.ts`、`store-sourced-question.db.test.ts`、`proposal-appliers.db.test.ts`、`auto-enroll.db.test.ts`、`import.db.test.ts`、`parts.test.ts`、`write-quiz.test.ts`、`verify-dispatch-outbox.db.test.ts`。
- submit/runtime：`submit.db.test.ts`、`submit-durable.db.test.ts`、`submit-durable-resource.db.test.ts`、`paper-cycle.db.test.ts`、`solve-submit.db.test.ts`、`probe-answer.db.test.ts`、`judge-run-dispatch-boss-contract.db.test.ts`、`ai_task_run_reconcile.db.test.ts`；invoker/durable/retry/contract scoped unit。
- typed transport新增故障fixture：401/422/429/529、超时、取消、返回模型不符、缺usage、输出schema无效、重试后未知费用、Jev→高级fallback失败；只mock传输不mock生命周期效果。
- 固定确定性性质：ID重排与标签引用、单多选/留空/错选、计分单元不重复、上限/档位、identity/hash、同key不同payload冲突、candidate不生效、activation CAS竞争、verify挂起与settle竞争。
- audits：`audit:schema`、`audit:draft-status`、`audit:draft-status-reads --strict`、`audit:capability-boundaries`、`audit:task-census`、`audit:structured-judge`、`audit:judge-prompts`、`audit:judge-golden`；触发fold改变才加fold/golden/rebuild验证，不把imperative revision硬变event-sourced。
- prompt修改运行`pnpm gen:prompt-hashes`并复核oracle；route变更同步Postman manifest并`pnpm gen:postman`。
- 本地仅scoped unit/DB/migration + typecheck/lint/build；完整`pnpm test`只在push后的exact-head CI Gate。
- actual-output：借鉴`src/server/ai/mimo-vs-glm-actual.db.test.ts`和`docs/planning/evidence/`的封存模式；Jev/高级/视觉按能力切片建立未见题族留出集，记录错误率、逐点误差、升级覆盖、成本/延迟。没有这些结果不能宣称任意题目的自动判分质量已验收。

## 7. 所有用户/客户端消费面

lane D核查了render→state→persist/resume→wire→API；以下不把wire enum当作已具备交互能力，也不把题库编辑权限误称为多租户安全漏洞。新实践投影避免作答前泄露评分依据，是本设计的明确要求。

| 消费面 | 当前实证 | 全量切换必须完成 |
|---|---|---|
| PfSolo | `PfSolo.tsx:270–316,596–641`单sel/选项文本；`:538–540`快捷键1–4；useState草稿无持久化 | ID集合单/多选、多slot/开放证据；serve-time绑定；草稿及pending恢复 |
| solo 202 | `ui/practice-api.ts:335–342`把pending抛为错误；服务端`submit.ts:895–908`已有202，judge-run-status route有poll/SSE | pending成为返回union与UI状态，不提示重交相同答案；同一次submission继续查询 |
| PfPaper | `PfPaper.tsx:136,283–303,618–637,786–809`每槽字符串，服务端autosave；`practice-api.ts:535–542`丢弃wire可用图片字段 | ResponseSet autosave/恢复；整组附件及逐slot回答；联合组提交/封存；保留session与计时语义 |
| PfRetro | `PfRetro.tsx:67,79–88,104–107`“已答·未判”、仅文本、指引回solo申诉 | 展示真实选项/原图/评分单元，accepted/superseded明确；同submission申诉，不要求重新作答 |
| placement | `ScreenPlacement.tsx:180–208,392–453`单选文本，有手写图入口；`:94–100`pagehide abandoned | 统一控件/提交；发题冻结；切换时不拿新题面承接旧答案，恢复/终止策略显式 |
| conjecture probes | `ProbeAnswers.tsx:113–134`文字+多图；独立probe answer路由 | 保留conjecture裁决语义，统一response/evaluation，不把探针结论伪装成普通题分数 |
| ingestion review | `src/ui/components/VisionTab.tsx:381–385,990,1044–1047,1269–1296`session恢复/结构预览/题面编辑 | 可审阅响应契约与评分来源/准入状态；保留原结构及原图，不把prompt编辑丢树当正常无损操作 |
| DraftReview | `DraftReviewPage.tsx:211–244,727,1093`自由文本answer/enable | stable key、规则缺项和来源可信度可见；人工force-enable不得绕过结构完整性/身份约束 |
| QuestionDetail | `QuestionDetailPage.tsx:187–199,786–863`从reference首字母猜key并修改reference头；`:888–922`physical parts | 结构化key/rubric编辑；编辑工作态→新revision；移除首字母hack |
| Manual mistake / 错题查看 | `RecordPage.tsx:128–139`错答图片写死[]；`web/src/routes/MistakesPage.tsx:223–239`文本对照 | 真实错答文本/图证据保留与展示，来源不混进参考key |
| stream/serve | 流状态服务端；placement仅给questionId后再getQuestion | issuance作为实际所见锚点；preselected不等于issued；in_progress必须绑定明确版本 |
| appeal回流 | `observability/ui/EventDetailPage.tsx:138–156`纠正链；Inbox已有judge_retraction | 不重造观测系统；练习/复盘读取effective selection并可定位原评分及复核链 |
| Copilot / artifacts | `ToolResultView.tsx:7–41`提案结果；`InteractiveArtifactRenderer.tsx:87`沙箱 | author/propose/write_quiz引用新契约；沙箱不是可直接信任的评分writer |
| 笔记题目引用 | `NoteBlocks.tsx:1–6`纯引用预览跳转；`notes/manifest.ts:61,185`embedded-check已退役 | 更新引用/跳转坐标；**不复活已删除的内嵌答题endpoint或新建答题面**，任意题型不等于扩展产品入口 |

除明确`src/...`外，practice UI短路径归`src/capabilities/practice/ui/`，placement归onboarding、ProbeAnswers归shell；API归对应capability。最终实施文件表应使用实际完整路径，不凭短名新建副本。

### 7.1 公私DTO和一致性

- `practice/api/question-detail.ts:118–134`对intervention诊断有sanitised投影，普通详情返回reference/rubric/metadata；solo与placement复用题库详情getQuestion，导致作答前已下载这些字段。普通题库详情可按产品权限看答案，不等于练习投影应收到它们。
- `paper-contracts.ts:126–136`的PaperQuestionFace不含reference，是可复用先例；paper-submit-route缓冲反馈不含分数，保留。
- 新增/分离**显式practice issuance DTO**：题面、所需共享材料/图表、ResponseSpec、opaque issuance/revision/part/slot/option身份；无答案键、私有rubric、模型计划、未经筛选metadata。不要靠UI不渲染来保密。
- 评分后feedback DTO按可见性policy揭示相应解析/评分依据；题库编辑DTO是另一个用途。generic revision JSON永不整体透传。
- 题面MathMarkdown仍可能含内嵌图片；源码无`figures/image_refs`独立渲染只能证明**结构化配图没有完整专用消费链**，不能断言所有图片都绝对不可见。必须用“markdown内嵌图+结构化figure+共享材料图”三种fixture分别验收。

### 7.2 通用交互覆盖，不按学科造控件

| 响应能力 | 统一发布的实现目标 |
|---|---|
| 单/多选 | stable option IDs，原生radio/checkbox或等价可访问控件；空集合与missing区分；选项数量不硬编码4 |
| 文本/数值/公式 | 保留原文输入和数学预览；结构化解释为派生证据，不悄悄重写原答案 |
| 多空/表格 | 每个显式slot可输入，按行列/题面定位显示；混合响应与整题计分不互相强制一对一 |
| 配对/排序 | ID对选择与可键盘操作的上下移动/序号编辑足够；**不以“暂时只文本兜底”当全能力完成，也不要求拖拽编辑器** |
| 证明/作文/作图/实验/复杂作品 | 通用文字+附件证据，图片可绑定整个evaluation group或明确子集；不用专用学科widget才能作答 |
| 题目图表/材料 | 独立共享材料与figure渲染、缩放、可读替代说明；判分与学生所见引用同版资产 |
| 音频/其他媒体 | 泛型原始附件能保留，不把`voice` enum当ASR/口语评分完成；若题目要求音高/发音/时序等原媒体证据，执行计划必须具备能力或明确需人工复核，转写不能冒充原媒体 |

不隐含增加浏览器执行任意代码、完整CAS、音频录音工作站、矢量作图器或QTI进出口。能力覆盖矩阵区分**可表达、可采集、可自动评分、需人工证据**，不能靠一条unsupported记录把自动评分声称全覆盖。

### 7.3 UI状态与推荐默认

- 区分草稿未提交、已提交待评、联合组暂定、材料不可读/待复核、生效、被替代；每个状态有submission锚点，刷新不造成重交。
- solo在答案持久化后可继续下一项，pending可回查；placement需当前结果才能自适应选下一题时显示等待/安全退出，不伪造评级推进。此为推荐交互，需design preflight批准。
- 整页解题照默认附到当前evaluation group，允许调整关联子集；不得靠模型未验证的切图归属把相邻题答案串用。
- 新serve默认不shuffle；stable IDs不自动授权重排，“以上都对”/引用字母选项保持原顺序。允许重排的题才做重排不改分性质测试。
- 未有发布计分规则时可保存/审阅，不作为可自动判分的练习发出；无需再让owner在“缺规则也猜着算”之间选择。
- solo/placement当前不持久化的浏览器草稿，不能被后端迁移凭空恢复；统一切换需明确维护提示与作答保存/等待窗口，不能默许上线丢答卷。

### 7.4 实施前UI design preflight材料（未批准，未写UI代码）

现有设计原文：

1. `docs/design/loom-refresh/project/pface-solo.jsx:1–3`：
   > 即时反馈（§6.4 着色即判定）· 评级建议可改 · 不服判（异步重判，不阻塞流）· 解题会话（苏格拉底分级提示，永不直接给答案，可提交手写图）
2. `docs/design/loom-refresh/project/pface-paper.jsx:1–3`：
   > §6.4 缓冲反馈的视觉语言：作答全程零语义色（导航 pip 只有「已答」的中性墨点），颜色在交卷瞬间才进场——色彩 = 判定。
3. 同文件`:39`：
   > 反馈缓冲：这张卷不给即时对错——交卷后统一判分。
4. `docs/design/loom-refresh/project/screen-onboarding.jsx:491–505`已有多选`role="group" aria-label="多选"`、`aria-pressed`、`ob-opt-multi`；`:524–530`已有文本+拍照。

组件类型：现有route内的**other（共享作答组件与卡内状态）**，非新page/drawer。整页证据查看如需modal必须单独声明后批准。

拟新建：`src/ui/components/response/`下`ChoiceSetResponse.tsx`、`TextResponse.tsx`、`EvidenceComposer.tsx`、`StimulusFigure.tsx`、`SlotResultBadge.tsx`、`response-types.ts`，以及配对/排序实现文件（在正式preflight列精确名）。

拟修改：PfSolo/PfPaper/PfRetro、ScreenPlacement、ProbeAnswers、VisionTab、DraftReviewPage、QuestionDetailPage、RecordPage、practice-api及对应contract/交互测试；NoteBlocks仅有需要时更新引用投影，不新建内嵌练习。

复用`src/ui/primitives/`、`MathMarkdown`、`uploadAsset/useAssetUrl`、`practice-face.css`与`web/src/globals.css`已有语义色/字体token；paper作答过程不着对错色。正式写UI代码前提交逐字引用、组件类型、精确完整文件清单并等待owner批准。

已定位UI测试：PfSolo interaction/a11y/capture、PfPaper autosave/capture/lifecycle/timing、PfRetro actions/states、VisionTab a11y；`tests/usability/shipped-container.spec.ts`当前不替代完整作答e2e。新增多选/混合slot/整页图/202恢复/无答案DTO/窄屏键盘/复判回流e2e。

## 8. 学习状态与结算矩阵（lane C，source-only）

本节为独立来源审阅（oracle lane C），**不是测试结论**；路径为仓库相对完整路径。

- **FSRS（顺序相关状态）**：`src/core/fsrs.ts:35–46` `scheduleReview(prevState, rating, now)` 单卡顺序推进；`:62–68` `initialFsrsState` 新建卡。持久化与版本/评级/时间由 `src/server/fsrs/state.ts` 单拥有者写入。
- **θ̂**：`src/server/mastery/state.ts:1046+` `updateThetaForAttempt` 写全量 θ̂/precision/counters/RT/grid，per-KC advisory lock `fsrs:knowledge:<id>`；在线路径**只读** `effectiveB = b_calib ?? b_anchor ?? b`，绝不写 `b_calib`。`:1167–1205` hierarchical-Elo 解析 per-domain θ_global（flag 默认关）；`:1330–1395` θ_global 每 domain 漂移一次（`mastery:ability_global:<domain>` 锁）。
- **p(L) 不是单纯 sigmoid(θ)**：`src/server/mastery/state.ts:597–657` `getMasteryProjection` 是 counts + representative β（`getRepresentativeKcBeta`）经 `pfaLogit(beta, PFA_GAMMA, PFA_RHO, success, fail)` + `pLearnedBand`。
- **family/个性化难度**：`src/server/mastery/personalized-difficulty.ts:283–371` `updateFamilyCalibration` 运行均值 + `calibrated_n` 门控；`:460+` `countDistinctQuestionsInFamily` distinct-question 门。门控未过时残差不折进，**不能事后减去 residual**。
- **重标定**：`src/server/mastery/recalibration.ts:479+` 标签需原始 stream π/前置 θ/客观非 partial；`:620–719` `recalibrateQuestion` PPI++ AIPW；`:658–669` below-threshold 返回 `updated:false, bCalib:null` **不清旧 `b_calib`** → 重建必须显式清。
- **KT**：`src/capabilities/practice/jobs/kt_estimate_nightly.ts` 确定性 soft track。
- **axis**：`src/server/calibration/axis-writer.ts:271+` `runAxisStateBatch`（RT/primaryKC）。
- **item_calibration 投影**：`src/server/projections/item_calibration.ts` / `src/core/projections/item_calibration.ts` 是**离线 Scheme A**，**不是**在线 θ̂ 的 owner（在线只读 effectiveB）。
- **生命周期操作**：enrollment/reset/merge/retire 必须纳入（如 `src/capabilities/ingestion/server/enroll.ts`、`src/server/mastery/retire-state-on-merge.db.test.ts`）。

## 9. 消费者/读模型矩阵与 replay 义务（lane C）

- **最新判分展示**：`src/capabilities/practice/server/practice-read.ts:269–308` 按 slot 取 newest judge。
- **paper detail / 重试回放**：`src/capabilities/practice/server/paper-detail.ts:301–470`；`src/capabilities/practice/server/review-settlement.ts:907–927` 重试 `LIMIT 1` 取 judge 回放收据。
- **done 重建必须拆分**：`src/capabilities/practice/server/judge-run-payload.ts:186–249` `reconstructDoneFromDomainEvents` 把 **newest judge 与 embedded 原判** 合并；必须拆成「原始执行收据」与「当前有效结果」两条读取。
- **读模型**：`src/kernel/read-models/question-activity.ts`、`src/kernel/read-models/failure-attempts.ts:252+`。
- **失败学习归因**：`src/capabilities/practice/server/failure-learning-attribution.ts:92–320` 写 judge，但**归因不是分数**。
- **订阅/变式/补全**：`src/capabilities/practice/server/failure-learning-subscription.ts`、`src/capabilities/practice/jobs/variant_gen.ts`、`src/capabilities/practice/server/lost-attribution-backfill.ts` 必须重核 generation、抑制 replay 付费 fanout。
- **进度信号**：`src/capabilities/practice/server/mastery-progress-signal.ts` post-commit 读需 committed snapshot；`src/capabilities/notes/server/mastery-progress-subscription.ts` 同族。
- **wrong-streak**：`src/capabilities/practice/server/enqueue-wrong-streak-nudge.ts` eligibility 重算，不重复投递。
- **prereq**：`src/server/mastery/prereq-propagation.ts:155+` graph/policy 冻结。
- **agency**：`src/capabilities/agency/server/intervention/settlement-subscription.ts` 仅在有效 activation 结算。
- **stream**：`src/capabilities/practice/server/stream-store.ts:218–229,807–829` 分离原始 rating/outcome 与 effective。
- **weekly/session summary**：`src/capabilities/practice/api/weekly.ts:48–72`、`src/server/session/summary.ts:64–99` 确定性统计 vs LLM stale。
- **memory**：`src/server/memory/triggers.ts:473+` `buildMemoryBriefRegenHandler` 用 Mem0+LLM；**不隐式 replay ingestion 或删除 fact**。
- **conjecture 证据读**：`src/capabilities/agency/server/conjecture/evidence.ts`、`probe-evidence.ts`。
- **export/attempt context**：`src/server/export/csv.ts:197–226` `buildMistakesCsv` + `src/capabilities/practice/server/tools/get-attempt-context.ts:888–940` 同时读 original 与 effective。
- **legacy mastery SQL view 不是权威**。
- **历史差异须保留**：`src/capabilities/ingestion/server/auto-enroll.ts:867–938` 在共享结算之外写 θ̂；`src/capabilities/practice/server/solve-session.ts:395–470` embedded grade+mistake+nudge 但**无共享 FSRS/θ̂**。

## 10. 现有 replay 不完整（lane C）

- **attempt-snapshot**：`src/capabilities/practice/server/attempt-snapshot.ts` 为 θ̂/FSRS 写 revert bracket（分段 checkpoint+snapshot）。
- **cascade-revert**：`src/server/revert/cascade-revert.ts:15–74,190–240` 因果闭包，遇后续状态冲突拒绝（fail-closed）。
- **restore-snapshot**：`src/server/revert/restore-snapshot.ts:88–130` 仅 knowledge partition；`:147–159` 丢 previous `last_review_event_id`；bare numeric θ̂ 被拒；**global ability 快照缺失**（θ̂ bracket `state.ts:1307–1327` vs global update `:1330–1395`）。
- **calibration/replay**：`src/server/calibration/replay.ts:1–29,84–175` 纯离线选定轨迹，不是全量持久化；`scripts/replay-urnings-lite.ts` 离线 spike。
- **corrections**：`src/kernel/events/corrections.ts:42–106` 按 `created_at/dispatch_seq/id` 排序 + effective-truth handle 链，**不是**已物化补偿。
- **entity-registry**：`src/server/projections/entity-registry.ts:114–158` 是 **8 类**（knowledge, knowledge_edge, goal, mistake_variant, learning_item, artifact, question_block, item_calibration）；**不要笼统说七类**。
- **rebuild/canonical**：`scripts/rebuild-projection.ts`、`scripts/migrate-canonical-projections.ts` 的七 canonical fold owner **≠** 学习 replay。
- **rejudge**：`src/capabilities/practice/jobs/rejudge.ts:128–179,182–213,227–327` 同 coarse 则 upheld；θ̂ 条件 revert；FSRS 不变；`reproject_deferred` marker 是**未完成义务**。

## 11. 有效判定 activation 契约（proposed）

- 创建 submission/group 时同时建立对应 head 行；`submission_id` 与 `evaluation_group_id` 必填，初始 `effective_evaluation_id = null`、`generation = 0`。
- **REQUIRED `expected_effective_id: null | id` 且 `expected_generation`**，防 ABA。
- 先锁 common learning-write，再一致地锁 submission/head；不可变 digest + group closure + admission generation 校验；派生 policy evidence；receipt + FSRS/θ̂/calibration + effective head + outbox **同事务原子**；模型调用在锁外。
- 可选 effect receipt（applied/ineligible/failed_pending）不得被吞。
- 服务端稳定学习顺序，分离 original occurrence/submitted/evaluation 时间；regrade 不算额外练习。
- 用户评级 provenance 独立；judge correction **绝不静默覆盖用户已确认评级**。
- 同 coarse 但分值变化的 partial 仍须是 meaningful replacement。
- 更晚到的早期证据走**有序 replay**，不在完成时追加，也不假装 evidence-only applied。

## 12. bounded assessment-learning replay（满足全量目标的工程建议；proposed）

- 冻结 text/images/parts/groups；checkpoint 定在目标之前，纳入其后依赖的 FSRS/KCs/domain-global/families/labels+calibration/lifecycle ops。
- 计算不调用 live subscriber；CAS head+learning generation 后再原子写 projections + effect head + invalidation outbox。
- 单学习者 post-checkpoint 全量 ledger replay 可接受，比最小图更简单；**benchmark 未测**。
- 保留历史实际使用的 calibration/policy 输入与真实 selection 概率/material delivery；**不反事实重做选题**，不用未来 calibration 反向回填。
- 模式：重算 state、作废 pending/stale 派生结论、保留已交付/用户已批准的历史动作与成本。
- replay 期间**不重发** models/nudges/memory。

## 13. 迁移默认捕获与 native 分类（lane C）

- 默认捕获 **cutover checkpoint 的精确观测**：FSRS/mastery 全 partition/family/item/calibration labels/axis/signals/结构血缘；**不是重算**，也不冒充 replay 已证明。
- 保留原始 eventID/body/time/actor/cost/causal 链。
- Native 分类：完整 attempt → submission+imported eval/head；embedded tutor grade；attribution-only 单独；human/import assertion 诚实标注；pending/native 缺件则 blocked；answer/live drafts 精确；缺 issued snapshot → native `historical_unresolved`（**不得用当前 revision 补造**）；correction cycles 保持 unresolved；deferred replay worklist。
- Pending 保留 run/request/pending 身份、response digest、revision mapping、eval generation、delivery disposition。
- Completed 但缺 DONE → reconstruct，**不 regrade**。
- **全量迁移 ≠ 批量历史重判**。
- 切换前 replay 支持不足时，由 owner 在「display-only correction」与「non-effective pending」间选择，**不得静默 applied learning**。

## 14. census 提案（`scripts/assessment-census.ts`，proposed，尚未存在）

- 与 apply 分离，显式 target，`REPEATABLE READ READ ONLY`，仅 SELECT。
- SQL/parser 清点：question source/status；event action/subject 计数；answer drafts/part refs/orphans；sessions；多 judge 分类（**不是全 corrupt**）；pending/appeal/reproject markers；先探 pgboss 版本/schema 再清点队列。
- parser：physical cycles/node ID/snapshot 完整性/grade-vs-attribution/correction 链/run 完成度/paper slot 边/stream π/learning effect 覆盖/assets/session claims。
- Manifest：images/source/migration/db 版本/redacted flags、语义 row 计数+PK、canonical hash、edge hash、projection baseline、queues/subscription disposition、blobs/digests、mapping unresolved 列表。
- **未测任何 counts/timing**。`MAX(dispatch_seq)` **不是**完整性（`src/db/schema.ts:1787–1794` 存在晚提交）；不可变事件事实单独取hash，`event.ingest_at` 等可变运维字段另行记录，不混入原始事实hash。

## 15. 统一切换 runbook（grounded，proposed）

- `README.md:68–78` env、`:137–176` 停 writer、`:195–208` services、`:218–245` dump/restore。
- `server/index.ts:3–5,75–83,120–125` 存在 embedded `RW_WORKER=1` 可能；`recoverToolOperationsBeforeServe` `server/index.ts:67–94` 在 HTTP 之前；`src/server/boss/start-worker.ts:92–112` recovery/subscriptions 启动顺序。
- 解析 Mac vs NAS/compose override/DB/全部 writer 进程/images/tools/auth/capacity preflight，不打印 secret。
- 隔离真实 backup restore，sanitize 但不简化边界样例，无生产凭证/model egress，隔离 blobs。
- census/import/hash 重跑 idempotency/fault/rollback，测 locks/WAL/duration。
- `scripts/mac-daily-dump.sh:25–28` 硬编码 path/container；`:40–44` 失败可能 exit 0 → 需 failure marker + restore 证明。
- `scripts/migrate.ts` 启动准备**宽于** SQL。
- 在 recovery/handlers/cron 之前建 DB epoch `preparing/ready/active` 与 app/worker 契约 guard；stale client 请求拒绝（新 guard **不能** fence 旧可执行；须停/防重启旧 writer 并验证连接）。
- maintenance：停新 admission/producer，有界 drain 或 translate queue（不删/不无限重试），保留 active sessions/drafts；停**全部** writer 后 final backup+manifest。
- migration lock：能单事务就单事务，否则在 fence 下分阶段离线可续跑 + 原子 final readiness；**不用 LLM 迁移**。
- subscriptions：`src/server/event-subscriptions/runtime.ts:162–233` `bootstrapSubscription` 把可见事件标 `bootstrap_skipped`；版本 bump 可能跳过 pending → 必须显式 translate outstanding delivery stable ID，既不盲目 replay 历史也不跳过。
- matched app/worker start/reconcile/reopen；**health 不是 readiness**；扩展 `scripts/delivery-evidence.ts` 的 assessment manifest。

## 16. rollback 边界（lane C）

- **新写入之前**：恢复一致的冻结 data/queues/subscriptions/assets + 旧 images。
- **新写入之后**：默认 maintenance + roll-forward；若必须 restore，先导出全部新 submissions/drafts/eval/receipt/blobs 并在独立 target 恢复且有证明的对账；旧 app 无法表示新 shape → **不存在无损 image rollback**。
- 保留旧 columns/images 作恢复安全，**不是** phased rollout。无部署授权。

## 17. work DAG（proposed）

contracts/policies → schema+snapshot → effective owner + 并行 census → evaluators/producers+UI+importer → replay/read consumers/invalidation → startup fences/pending translation+backup/export/constants coverage → 隔离演练 → exact-head gates → **一次 release**。

独立实施 lane 各自 worktree branch，无重叠 writer；一个集成 release，**不做部分 flip**。

## 18. release tests（proposed）

强制：null CAS/ABA/racing supersede；commit before DONE 重试；pending before enqueue 失败；slow early result；manual rating；coarse 不变但 points 变；stale group；attribution not grade；global counters/grid/RT；below-threshold calibration 清旧值；KC merge/retire；replay 无付费效应；unresolved history；import/hash 幂等；旧 client/worker fenced；bootstrap pending；migration crash；两个 rollback 边界；本机 scoped + typecheck/lint/build，完整 CI 只在 exact-head。

## 19. owner 决策（仅实质）

1. partial-credit/group → 学习证据的语义解释。
2. model-proposed marking rule 的准入。
3. 历史不可 replay 纠正的处置策略。
4. appeal auto-accept vs explicit。
5. Jev 评测授权/预算。
6. maintenance/RPO（建议：零 accepted-answer 丢失）。

建议供裁决：完整保存逐点得分，但不默认把相关得分点放大为独立练习；模型拟定规则必须保留来源并经明确准入政策，不等同官方核验；历史证据不足时允许清楚标注的展示纠正、保留原学习基线；申诉沿用现有自动复核意图，只有输入完整、规则准入和重算全部通过才自动生效，否则待确认。以上均为建议，不视为owner已批准。付费评测额度与维护窗口另行授权。

SQL/CAS 等工程细节不需 owner 决策。新增笔记内嵌 quiz 不在本次题目契约迁移范围内。实施时按改动基线更新受影响路径与证据，不把本次源码调查当作永久有效的运行证明。

## 状态与证据缺口

- 本文为 **source-only grounding**：lane A/B/C/D 调查已归并，源码路径与行为结论有文件/符号/行号；**未**执行 schema/data migration、生产访问、付费模型评测或部署。
- **产品决策与证据缺口仍开放**：§19 owner 决策未拍；无本轮库存 census、隔离 restore 演练、actual-output 或全产品浏览器证据。
- 因此本文是实施规划基线，**不是**可直接交付实施的最终 spec，也不代表任何能力已上线或已验收。
- Linear capture：已搜索复判/pending/评分并更新YUK-1038（comment `f88785c9-97e7-446c-96fa-294978b36d43`）。订阅灾备语义复用YUK-766，得分点→学习证据政策复用YUK-438；已分别留言，不重复建票、不冒称完成。其余实施内缺口纳入YUK-1038，实施拆票待产品裁决。
