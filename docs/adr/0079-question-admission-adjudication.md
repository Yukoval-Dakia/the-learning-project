---
status: accepted
---

# ADR-0079 — 题目准入：独立解答、语义裁决与可修复退回

决策来源：YUK-1804 的协调线裁决及更正（2026-11-05）。更正优先：裁决目标由任务配置指定为 openai/gpt-6.1-sol，thinking high；单调区间的端点写法按题目语义判断，不设开闭端点一律不同的规则。

## 决定

题目准入仍只有 `question_admission_run` 一个后端。结构、作答契约、来源授权和图资产先检查；两次独立盲解均不见作者答案、来源答案或对方解答。冻结图资产按版本读取并随调用发送。图不存在而题面引用图时显式传 `missing_referenced`，强制裁决文字是否独立足够；不用关键词白名单猜测图是否承重。资产存在但不可读取时当场退回补图。纯文字调用不要求模型具备视觉；实际带图时在中央 runner 的 beforeProviderQuery 按已解析的 provider/model 再核视觉能力，不满足则不发送并按系统配置原因收口，不删除图片或偷偷改用文字。

确定性键一致或文本归一后有交集时可走快路径。交集路径只铸双方都证实的写法，绝不把两边未相互证明的额外别名一起发布。作者键不接受盲解、两次解答不同、缺图引用、自由作答或需要验证印刷规则时，交裁决员。作者和来源答案只是证据；错误证据不否决正确题目，裁决可给出更正后的键。

裁决模型只经 `task.QuestionAdmissionAdjudicateTask.provider/model` 配置，并显式启用 `override_global_pin=true`，不采用注册表中的占位默认路由。模型、档位与实际费用以每次中央 task run 的记录为准；未配置时不自动挑一个模型。配置页沿用既有 per-task 配置能力。

模型只能输出通过或退回修复。每单元返回字段：

```text
pass: {scoring_unit_id, verdict: pass, decided_key, reason_md,
       ai_grading_sufficient?, evidence_errors: [{which, note}]}
return: {scoring_unit_id, verdict: return_for_repair, reason_md,
         repair: {repair_target, broken_part, defect, fix_hint_md, suggested_key?},
         evidence_errors: [{which, note}]}
```

- `repair_target`: `question_text | scoring_structure | reference_answer | figure`
- `broken_part`: `question | options | figure | scoring_unit | reference`
- `defect`: `missing_figure | missing_condition | wrong_domain | scoring_kind_mismatch | impossible_context | ambiguity`
- `evidence_errors.which`: `source_answer | printed_rule | author_key`

自由作答通过必须有 `ai_grading_sufficient:true` 与含参考解和评分依据的 `free.rubric_md`。证明要求必须由 AI rubric 覆盖，不能仅铸最终结论字符串。单个语义单元本身不是结构错误；可作答而参考解或 rubric 错时通过，替换错误判分依据并写 evidence_errors，不能仅因证据错误退回。系统故障与缺少可用判分切片如实记原因，不伪造题目缺陷或人工复核。

发布仍使用原来的冻结 revision seam。通过后由新键生成新 revision；答案与裁决材料只进私有判分与准入证据，不进公开题面。金标仍只能由 Owner 认证。旧 `admission@1/@2/@3` 收据仍可应用；新发送使用 `admission@4`，不跳过已支付的终态或 unknown 义务，不重跑存量数据。

## 判分方法与被取代的边界

本文取代 ADR-0073 D1 的来源答案否决、D2/D3 的 AI 单元逐题探针，以及 D4/D5 和硬边界中将所有判分方法一律按「未逐题标定不出」「判不了不出」处理的部分。确定性单元仍执行同一生产判分核心的冻结探针。解答类默认绑定 `AssessmentRuleJudgeTask` 的当前有效系统级留出题切片，不再逐题调用 AI 探针、不生成新的人工复核执行计划。没有有效系统切片不能冒充已准入。

模型级留出题证据在系统层封存并复用，不因每道新题重复支付。ADR-0073 的「每科至少 30」不再是题目自身准入的逐题要求；当前切片登记仍沿用现有 30 题保守阈值与科目/响应类/模型版本绑定，在另有覆盖标准前不擅自降低。它不是对每道题正确性的证明。规则判分沿现有 model_slice_admission_run 使用同一生产执行器；发布计划将现有判分 task 预算冻结成单元费用上限，执行仍与调用者和当前 task 上限取交集，不另外发明费用策略。统一费用入口仍归 YUK-1801。实际覆盖与未覆盖范围须在验收中报告。

保留 ADR-0073 D4 与硬边界第 5 条：学习者实际作答判不了就显式 pending，不造分、不伪零分。新执行计划的 `on_low_confidence:pending` 沿用已有待判与重判链，历史计划的人工策略仍可读取。本文不改历史 Judgment。

## 重试与恢复

每个解答/裁决调用在同一个仍存活的付费 batch 内最多两次。每次调用都有独立中央 task run、实际路由与费用记录。解析失败、已知服务错误，以及有证据未发送的连接失败可运行内重试。额度错误不换模型，转入下述有恢复条件的等待，不做运行内忙重试。崩溃、发送后无响应、租约失效或终态不明仍保留 unknown 义务，不自动重发。收据密封或发布失败不视为模型解析失败，不能触发重付费。

新门有结论时只有通过/退回；持久化生命周期继续使用既有 admitted/withheld 兼容字段。真正不明的付费效果状态不是题目质量裁决，不伪装成通过或自动重新购买。准入证据 append-only，退回原因可由备题员消费；没有作者的旧来源由系统收口，定位继续请求下一题。旧供题功能与删除时机仍归 ADR-0078，不在本文新增其功能。

## 不变的职责

危机转介逻辑不改；危机倾诉与受限学习者材料不能进入准入模型、横幅或长期记忆。模型发送前复核原来源用途；默认 allow 不算来源证明，所有绑定来源都须检查。照片和私密材料沿原用途授权，不借网页来源字段豁免。凭据只由服务端 runner 读取；题面、公开投影和日志不持 provider key。

## 额度与登录等待（恢复协议）

额度用尽或登录失效是唯一允许的非终态等待。快路径继续通过；需要裁决的题记录等待，不算退回，不自动降级。目标路由改变只经显式任务配置。额度/登录失败由 provider 的类型化接口提供；门不从错误字符串猜额度、不自造另一套 provider 分类。当前 pi-ai 路由没有可用的重置时间，retry_at 是门安排的下次尝试时间，绝不标成额度恢复时间。

等待记在 `paid_effect` 的两层既有账本上，不新增表：`question_admission_run/admission@4` 保存原 revision/digest 和原来源绑定，等待时写不可变 `question_admission_wait` 收据并停在 receipt_ready；`question_admission_stage` 按 call index/attempt 保存每次中央调用的冻结输入、任务路由配置和结果/失败/等待收据，已知结果可应用，恢复复用成功调用。等待不是 question_admission_verification 的质量失败，也不是退回。已返回的额度拒绝是已知结果，不能记 unknown；尚未物理发送的裁决也不记 unknown。已完成的盲解恢复时复用，不重新支付。只有真实不明的在途发送与崩溃继续保留 unknown、不自动重发。

门拥有重驱与退避：同一调用第一次额度失败后等 5 分钟，后续失败依次等 15、30 分钟，此后每小时一次直到成功。每次只安排一个未来投递，不忙轮询、不在一次运行内无界重试；每次实际发送都有独立的付费阶段与中央 task run。`question_admission_run` 在写等待收据的同一事务用 pg-boss `startAfter` 和包含 stage attempt 的稳定 job id 持久化唤醒。每次唤醒重新检查来源、版本、配置与原付费义务，复用成功盲解，仅重新发送已知额度拒绝的调用。`retry_at` 是门自己的退避时间，不能描述成 provider reset 时间。

登录失效与额度用尽分别记录：登录等待不定时自动重试，定位页提示 Owner 重新登录；重新投递同一后端并携带 `recovery_confirmed:true` 可确认恢复。操作员也可显式更换 task provider/model 后重新投递；一个确认 delivery 只授权一次新尝试，预算/档位变化不算换模型，不解锁等待。定位跳过等待题尝试下一题，展示等待原因与下一次尝试时间。供题进度只投影等待原因、可选时间与恢复动作，定位选择仍只取 admitted 题。`AdmissionRecoveryReader` 是未来 provider 类型化失败的窄接缝；当前仅复用已有 AgentRunError 的绑定 HTTP 429（额度）/401（登录）事实，不解析错误字符串。#2480 未合入前开发不依赖它的 head，用显式配置中的已有模型检查流程；这些数字不算 Sol 模型验收，不与复核表作硬线比较。

裁决任务由新门在 worker 进程内串行，排队后重新核验来源/paid fence，再申请本次阶段发送。快路径不进入该队列。provider store 的进程内文件读写串行与任务串行是两件事；新门不实现凭据文件锁、刷新或登录。进程崩溃后只对已有已知等待按持久化投递恢复；sending/unknown 不自动重发。

TEST 部署当前的假设是只有单个 worker 进程持有凭据；裁决任务在该进程内串行由新门实现。部署依赖是 Owner 在 TEST/NAS 主机通过浏览器回调交互登录一次；不能假设无头登录可行。凭据位置经 `OPENAI_CHATGPT_AUTH_FILE` 配置，专用文件只由 worker 读写，不从 Mac 复制凭据，不写死内容格式。#2480 负责文件读写串行、原子写回与 modify 的 60 秒上限；多处登录是否互相作废和刷新令牌是否可隔离仍须功能线核实。若假设不成立，回协调线改方向。Sol 真实验收等 #2480 合入后再 rebase，且须 Owner 确认凭据可独占；此前不调用。真实并发、请求档位和用量必须实测；发版时 TEST 尚未登录才允许操作员显式配置 flash 过渡并记录，产品不提供自动 fallback。

恢复得到最终裁决后不覆盖原等待收据：最终验证追加到原发布 seam，记录各阶段 paid identity/digest；发布绑定仍指向原 coordinator 收据的真实 digest，另记 derived_result_digest。任何阶段 sending/unknown 都阻止新发送，租约到期只分类 unknown。阶段收据回放不重新记费用；中央 task run/cost ledger 是单次费用真相。中央 runner 的 beforeProviderQuery 之前被配置或授权检查挡住时，阶段保存 not_sent 的已知结果，协调收据按系统原因收口；不伪造题目缺陷，也不把没有 task run 的调用记成未知费用。尚未发送的调用没有 unknown，已知额度/登录拒绝存已知等待收据；发送后结果不明仍 unknown，绝不把它当额度等待自动重试。
