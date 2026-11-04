---
status: accepted
---

# ADR-0079 — 题目准入：独立解答、语义裁决与可修复退回

决策来源：YUK-1804 的协调线裁决及更正（2026-11-05）。更正优先：裁决目标由任务配置指定为 openai/gpt-6.1-sol，thinking high；单调区间的端点写法按题目语义判断，不设开闭端点一律不同的规则。

## 决定

题目准入仍只有 `question_admission_run` 一个后端。结构、作答契约、来源授权和图资产先检查；两次独立盲解均不见作者答案、来源答案或对方解答。冻结图资产按版本读取并随调用发送。图不存在而题面引用图时显式传 `missing_referenced`，强制裁决文字是否独立足够；不用关键词白名单猜测图是否承重。资产存在但不可读取时当场退回补图。纯文字调用不要求模型具备视觉；实际带图时在中央 runner 的 beforeProviderQuery 按已解析的 provider/model 再核视觉能力，不满足则不发送并按系统配置原因收口，不删除图片或偷偷改用文字。

确定性键一致或无声明形状文本的归一化别名集合完全相等时可走快路径；只有交集时转裁决，不裁掉可能正确的写法。有声明形状时，双方每个别名都须编译到同一数学对象。带作者键时逐一用原判分器验证每个解题者别名，两解还须相互一致；通过后保留作者完整键、数值容差和选择集合，既不裁作者写法，也不铸入未经原键验证的新写法。作者键不接受盲解、两次解答不同、缺图引用、自由作答或需要验证印刷规则时，交裁决员。作者和来源答案只是证据；错误证据不否决正确题目，裁决可给出更正后的键。

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
- `defect`: `missing_figure | missing_marking | missing_condition | wrong_domain | scoring_kind_mismatch | impossible_context | ambiguity`
- `evidence_errors.which`: `source_answer | printed_rule | author_key`

自由作答通过必须有 `ai_grading_sufficient:true` 与含参考解和评分依据的 `free.rubric_md`。证明要求必须由 AI rubric 覆盖，不能仅铸最终结论字符串。单个语义单元本身不是结构错误；可作答而参考解或 rubric 错时通过，替换错误判分依据并写 evidence_errors，不能仅因证据错误退回。系统故障与缺少可用判分切片如实记原因，不伪造题目缺陷或人工复核。

题面依赖加点、下划线、波浪线、着重号、方框或图上标注时，检查公开题干、该 part 引用的公开材料及选项；明确没有对应标记、也未明确用文字指明目标的，在任何付费调用前退回 `question_text/question/missing_marking`。图上标注即使无图也不直接退回：题面可能已经完整给出坐标、标签和条件，缺失状态强制裁决文字是否独立足够。直接用文字“加点词语为…”指明目标也不要求一定有引号，交裁决核全目标。原始 HTML 不渲染，不作为可见标记。可见 Unicode 标记、实际数学渲染中的标记命令、公开图或 Markdown 强调只作为候选，文字明确指明目标也只作为文本识别状态，均强制裁决员核实所有目标是否可辨，不能因任意引号、粗体或无关图片而走快路径。裁决提示词只允许使用学习者可见的题面，不从参考解补标记。

选择题题干末尾只有在全部选项按序连续出现、标签对应且正文在仅折叠空白后逐项完全一致、删后仍有非空题干时，才确定性去掉该段；多个选择槽或部分/不清楚的匹配退回 `question_text/options/ambiguity`。不修改选项身份、顺序和内容，不从中间删除文字，不在页面去重。盲解和裁决读取去重后的题面，通过后沿现有 resolved publication seam 生成新 revision；冻结付费输入与 `question_text.changes` 保留原文、part_id 和新文。退回的题保留原 revision，既有证据不回写。

发布仍使用原来的冻结 revision seam。通过后由新键生成新 revision；答案与裁决材料只进私有判分与准入证据，不进公开题面。金标仍只能由 Owner 认证。旧 `admission@1/@2/@3` 收据仍可应用；新发送使用 `admission@4`，不跳过已支付的终态或 unknown 义务，不重跑存量数据。

## 判分方法与被取代的边界

本文取代 ADR-0073 D1 的来源答案否决、D2/D3 的 AI 单元逐题探针，以及 D4/D5 和硬边界中将所有判分方法一律按「未逐题标定不出」「判不了不出」处理的部分。确定性单元仍执行同一生产判分核心的冻结探针。解答类默认绑定 `AssessmentRuleJudgeTask` 的当前有效系统级留出题切片，不再逐题调用 AI 探针、不生成新的人工复核执行计划。没有有效系统切片不能冒充已准入。

明确取代 ADR-0073 边界 2、6 中按科目分别准入及「每科至少 30」的相关要求：AI 判分在系统层准入一次，一个切片绑定判分模型版本与响应类型，不按科目分切片；科目只记录覆盖情况。每道题不重复支付系统级准入费用。

该证据叫「参考模型对照」，不是金标。`calibration` 如实为 `uncalibrated`，学习者须能看到结果由 AI 判定、尚未校准。金标仍只有 Owner 能认证；这里不写金标，也不借用金标字段。系统准入硬线、参考模型选择、切片登记和学习者可见标记由 YUK-1826 执行，本文不把它们写成已经完成。

现行 `model_admission_slice` 与 `model-slice-registry.ts` 的 subject 绑定及证据/标记接线由 YUK-1826 落实，#2489 不扩范围修改这些机制。没有有效切片时，解答类仍不可发布；验收分列门的结论、最终产品状态和可发布性，逐题列出缺切片的扣留。现有发布执行预算仍取已配置 task、调用者与冻结单元上限的交集，统一费用入口归 YUK-1801。

保留 ADR-0073 D4 与硬边界第 5 条：学习者实际作答判不了就显式 pending，不造分、不伪零分。新执行计划的 `on_low_confidence:pending` 沿用已有待判与重判链，历史计划的人工策略仍可读取。本文不改历史 Judgment。

## 重试与恢复

每个解答/裁决调用在同一个仍存活的付费 batch 内最多两次。每次调用都有独立中央 task run、实际路由与费用记录。解析失败、已知服务错误，以及有证据未发送的连接失败可运行内重试。额度错误不换模型，转入下述有恢复条件的等待，不做运行内忙重试。崩溃、发送后无响应、租约失效或终态不明仍保留 unknown 义务，不自动重发。收据密封或发布失败不视为模型解析失败，不能触发重付费。中央 runner 已提供的 helpProviderFault 类型标记一并消费：quota 进入等待；parse/bad_gateway 只有中央尝试已结束时才允许本次有界重试，失败阶段收据保留原标记供回放使用，不按错误文字猜类型。既有 unknown 不因新识别逻辑自动改类或重发。

新门有结论时只有通过/退回；持久化生命周期继续使用既有 admitted/withheld 兼容字段。真正不明的付费效果状态不是题目质量裁决，不伪装成通过或自动重新购买。准入证据 append-only，退回原因可由备题员消费；没有作者的旧来源由系统收口，定位继续请求下一题。旧供题功能与删除时机仍归 ADR-0078，不在本文新增其功能。

## 不变的职责

危机转介逻辑不改；危机倾诉与受限学习者材料不能进入准入模型、横幅或长期记忆。模型发送前复核原来源用途；默认 allow 不算来源证明，所有绑定来源都须检查。照片和私密材料沿原用途授权，不借网页来源字段豁免。凭据只由服务端 runner 读取；题面、公开投影和日志不持 provider key。

## 额度与登录等待（恢复协议）

额度用尽或登录失效是唯一允许的非终态等待。快路径继续通过；需要裁决的题记录等待，不算退回，不自动降级。目标路由改变只经显式任务配置。额度/登录失败由 provider 的类型化接口提供；门不从错误字符串猜额度、不自造另一套 provider 分类。当前 pi-ai 路由没有可用的重置时间，retry_at 是门安排的下次尝试时间，绝不标成额度恢复时间。

等待记在 `paid_effect` 的两层既有账本上，不新增表：`question_admission_run/admission@4` 保存原 revision/digest 和原来源绑定，等待时写不可变 `question_admission_wait` 收据并停在 receipt_ready；`question_admission_stage` 按 call index/attempt 保存每次中央调用的冻结输入、任务路由配置和结果/失败/等待收据，已知结果可应用，恢复复用成功调用。等待不是 question_admission_verification 的质量失败，也不是退回。已返回的额度拒绝是已知结果，不能记 unknown；尚未物理发送的裁决也不记 unknown。已完成的盲解恢复时复用，不重新支付。只有真实不明的在途发送与崩溃继续保留 unknown、不自动重发。

门拥有重驱与退避：同一调用第一次额度失败后等 5 分钟，后续失败依次等 15、30 分钟，此后每小时一次直到成功。每次只安排一个未来投递，不忙轮询、不在一次运行内无界重试；每次实际发送都有独立的付费阶段与中央 task run。`question_admission_run` 在写等待收据的同一事务用 pg-boss `startAfter` 和包含 stage attempt 的稳定 job id 持久化唤醒。每次唤醒重新检查来源、版本、配置与原付费义务，复用成功盲解，仅重新发送已知额度拒绝的调用。`retry_at` 是门自己的退避时间，不能描述成 provider reset 时间。

登录失效与额度用尽分别记录：登录等待每小时只选该 provider/model 路由的一道当前等待题探测，仍提示 Owner 重新登录；学习者页面只显示校验服务暂不可用，不暴露内部角色或凭据细节。重新投递同一后端并携带 `recovery_confirmed:true` 可确认恢复。操作员也可显式更换 task provider/model 后重新投递；一个确认 delivery 只授权一次新尝试，预算/档位变化不算换模型，不解锁等待。定位跳过等待题尝试下一题，展示等待原因与下一次尝试时间。供题进度只投影等待原因、可选时间与恢复动作，定位选择仍只取 admitted 题。`AdmissionRecoveryReader` 是未来 provider 类型化失败的窄接缝；当前仅复用已有 AgentRunError 的绑定 HTTP 429（额度）/401（登录）事实，不解析错误字符串。#2480 未合入前产品 PR 不依赖它的分支；独立验收分支可整合协调线确认的固定依赖版本。已有配置模型的流程数字不算 Sol 模型验收，不与复核表作硬线比较。

登录暂停以现有阶段 paid receipt 持久化，按任务配置中的 provider/model 共享：串行队列内读取该路由最近一次真实结果/等待，最新为 login 时，其他题只追加继承等待收据，不调用 provider、不刷新失效令牌，也不产生 task run 或未知费用。继承等待不覆盖路由恢复事实；最近一次真实成功或额度拒绝可解除登录暂停。自动探测的 `login_probe_route:{provider,model}` 只允许命中暂停路由并已到下一次探测时间的投递穿过暂停；普通题即使到时也不能各自刷新。登录等待的 `retry_at` 是下一次探测时间，`recovery_action` 仍为 reauthenticate。写 coordinator 等待收据与创建首个 pg-boss 探测投递在同一事务，family control 锁下按路由查重，只有一个待运行/在运行的探测。探测成功后将同路由、仍绑定当前 revision 的全部登录等待题排入原串行后端；失败追加新的等待并安排一小时后下一次探测，不逐题报错刷日志，不自动换模型。被取代的探测题先应用 stale，再从其他当前等待题选下一道；用途不允许则不发送并跳过该候选。没有候选时不维持空探测；新等待题进入时重新确保探测存在。凭据失败若证据证明查询未开始，不产生新 paid unknown；有中央失败收据时保留真实费用事实，不凭空把未知计为零。手动恢复投递须创建于最近一次登录失败之后，一个确认只授权一次探测；若批量确认的第一题仍登录失败，旧确认队列中余题继续等待，不逐题再等刷新超时。切换到不同 provider/model 走新路由，预算或档位变化不能清掉登录暂停。原 sending/unknown 仍不重发。

裁决任务由新门在 worker 进程内串行，排队后重新核验来源/paid fence，再申请本次阶段发送。快路径不进入该队列。provider store 的进程内文件读写串行与任务串行是两件事；新门不实现凭据文件锁、刷新或登录。进程崩溃后只对已有已知等待按持久化投递恢复；sending/unknown 不自动重发。

TEST 部署当前的假设是只有单个 worker 进程持有凭据；裁决任务在该进程内串行由新门实现。部署依赖是 Owner 在 TEST/NAS 主机通过浏览器回调交互登录一次；不能假设无头登录可行。凭据位置经 `OPENAI_CHATGPT_AUTH_FILE` 配置，专用文件只由 worker 读写，不从 Mac 复制凭据，不写死内容格式。容器必须挂载凭据所在目录，不能 bind mount 单文件：原子 rename 在单文件挂载下会报 EBUSY，刷新成功后可能无法写回。API 和其他进程不设置该变量、不读写该目录。#2480 负责文件读写串行、原子写回与 modify 的 60 秒上限；多处登录是否互相作废和刷新令牌是否可隔离仍须功能线核实。若假设不成立，回协调线改方向。Sol 真实验收须在已确认支持目标路由的固定产品版本上运行，并经 Owner 确认凭据可独占；依赖未正式合入时只在本地验收分支整合，不带入产品 PR，正式合入后再同步 main。真实并发、请求档位和用量必须实测；发版时 TEST 尚未登录才允许操作员显式配置 flash 过渡并记录，产品不提供自动 fallback。

恢复得到最终裁决后不覆盖原等待收据：最终验证追加到原发布 seam，记录各阶段 paid identity/digest；发布绑定仍指向原 coordinator 收据的真实 digest，另记 derived_result_digest。任何阶段 sending/unknown 都阻止新发送，租约到期只分类 unknown。阶段收据回放不重新记费用；中央 task run/cost ledger 是单次费用真相。beforeSend 的用途/控制闸和中止不转成 not_sent。beforeProviderQuery 同一路径中已证明未查询的中止保存 interrupted 事实；若已有中央失败收据则保留真实失败与费用，随后中断，不作题目退回。用途撤回沿原 pending 路径，停机不落题目终态；已发送且结果不明仍受原 unknown fence 约束。只有既非用途/控制撤回也非中止的查询前阻断保存 not_sent，协调收据按系统原因收口；不伪造题目缺陷，也不把没有 task run 的调用记成未知费用。尚未发送的调用没有 unknown，已知额度/登录拒绝存已知等待收据；发送后结果不明仍 unknown，绝不把它当额度等待自动重试。

重授权与新发送共用 QUESTION_ADMISSION_CONTRACT_VERSION / QUESTION_ADMISSION_PAID_UNIT；发布后继时拒绝与当前 unit 不符的计划，并使用当前版本的 job payload。历史计划和收据仍可读取，但不能拿旧版本计划开启新付款；不自动重跑存量。

等待恢复在进入任何新阶段 reserve 之前复核当前 revision id 和封印 digest，与最终应用共用同一判据；已被取代的 coordinator 收据直接应用 stale，不支付裁决。排队后、provider query 前以及模型结束落终态前再次核原来源用途、生命周期、付费 fence 和当前 revision。任务配置从当前配置读取；原成功调用仍复用，模型路由只有显式配置更改才解锁旧路由等待，预算/档位改动不视为换模型。
