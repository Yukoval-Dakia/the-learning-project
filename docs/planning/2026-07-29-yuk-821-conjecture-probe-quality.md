# YUK-821：猜想与诊断题质量收口（P0 已实施，P1 仅计划）

## 1. 为什么原来的两项会失败

原链路让同一次模型输出同时做三件事：归纳猜想、写第一道题、写第二道题。系统只检查字段齐不齐、两道题文字是否不同，却没有保存“这两道题到底必须诱发哪一个错误”的正式合同。因此模型可以写出看起来合理的题，但题和猜想已经不在同一条因果线上。

### 失败一：复合单位换算

- 输入证据只支持一个较窄的错误：目标单位的**分母时间单位发生变化**时，学习者没有换算分母。
- 模型把猜想扩大成“复合单位换算普遍有问题”。
- 后续题虽然换了数字或单位外观，却没有真正改变分母时间单位，因此答错也不能证明原猜想，答对也不能反驳原猜想。
- 这不是“答案算错”这么简单，而是 **claim 的范围扩大了，probe 又丢了触发条件**。

### 失败二：异分母分数相加

- 输入证据支持的是：两个分母不同的时候，把分子、分母分别相加。
- 模型把猜想扩大成“分数加法都有问题”。
- 后续题变成同分母相加；此时“分母分别相加”并不是原错误规则在原触发条件下的表现。
- 这道题可以测一般分数运算，却不能测我们声称的那个具体误区，属于 **claim/probe 错配**。

共同根因不是模型不够聪明，而是系统把“模型自己说这题有区分度”当成了事实，也没有把触发条件、适用边界和目标错误答案固定下来。

## 2. P0 已实施：系统现在怎样阻止这两类失败

### 2.1 先冻结诊断合同，再出题

`MindModelInductionTask` 现在只输出：

1. `claim_md`：对学习者思维方式的猜想；
2. `DiagnosticSpec`：
   - `target_error_rule_md`：具体错误规则；
   - `trigger_conditions_md`：什么条件出现时才会触发；
   - `scope_boundary_md`：明确不覆盖什么；
   - `expected_wrong_answer_signature_md`：按该错误规则作答会留下什么可识别特征。

这一阶段禁止输出题目。这样模型不能为了迁就自己已经写好的题，反过来改宽猜想。

### 2.2 共识比较完整合同，不只比较一句 claim

三次独立归纳要在 claim 和整个 `DiagnosticSpec` 上语义收敛。即使三次都写了“单位换算有问题”，只要一次限定“分母时间变化”，另一次泛化到“所有复合单位”，系统也不把它们算成同一票。

### 2.3 独立的出题与复核调用

共识形成后才调用：

- `ConjectureProbeAuthorTask`：依据冻结合同一次生成完整双题包；
- `ConjectureProbeReviewTask`：同模型的第二次独立调用，只审查，不允许替作者修题。

复核固定检查：范围是否扩大、触发条件是否丢失、两题是否只是换数字、参考答案是否正确且唯一、目标错误答案是否真的不同于正确答案。

### 2.4 确定性结构门

在交给复核模型之前，代码先做不依赖学科知识的硬检查：

- 两道题不能是同一题的标点或空白变体；
- 两道题的 `context_kind` 必须不同；
- 两道题的 `representation_kind` 必须不同；
- 每道题的正确答案与“目标错误答案”必须不同。

这些检查在生成链、proposal schema 和最终接受路径重复执行，避免伪造一个 `passed=true` 就绕过。

### 2.5 只允许一次整包重生成

- 第一次语义或结构质量失败：丢弃整包，重新生成两道题；
- 第二次仍是质量失败：返回 `abstain(no_discriminating_probe)`，不创建可接受的猜想；
- provider 超时、调用异常或无效结构化输出：记为 operational failure，交给 worker 重试，不能当成“模型投了反对票”。如果两次尝试中混入 operational failure，剩下的一次质量失败也不能凑成“两票失败”并错误 abstain。

### 2.6 可追溯、可接受、可拒绝

新 proposal 保存：冻结合同、两道题的完整 spec、每次 author/reviewer task run id、失败码、解释和最终通过记录。新的 accept 路径缺任一字段、嵌套题与实际持久化题不一致、结构门失败或最终 audit 未通过时，返回 409 `CONJECTURE_PROBE_QUALITY_REQUIRED`，要求重新准备；已经接受的历史记录仍可幂等读取。

自动 nightly 和 agent-led director 共用同一质量门，不存在一个入口严格、另一个入口仍可绕过的双轨。

## 3. P0 的边界

P0 可以识别“题目范围/结构明显不匹配”，也让独立模型审查学科语义；它还不能用确定性代码证明某个数学答案一定正确。

例如：

- 它能要求单位换算两题使用不同情境和表征，但不能仅靠通用字符串规则证明分母时间单位确实从 hour 变成 second；
- 它能要求分数题保留同一目标错误，但不能仅靠通用规则证明两个分母确实互异、错误答案确实来自“分子分母分别相加”。

这部分是 P1。按照 owner 决定，本次不写 P1 代码，下面只给实施计划；Linear 已单独
建为 `YUK-822`，避免它被误报成 YUK-821 已交付的一部分。

## 4. P1 详细实施计划（本次不实施）

### 4.1 目标

为“可以确定性验证的学科错误模式”增加窄验证器。验证器不是新的中央题库，也不是一个按学科不断增长的 `switch`；它只回答：这一个已经生成的双题包，是否真的保留了冻结合同中的目标错误与触发条件。

### 4.2 模块边界

计划文件：

- `src/subjects/probe-quality.ts`
  - 定义 `SubjectProbeValidator` 窄接口、版本、适用性与结果类型；
  - 组合各科贡献列表并按 `subject_id` 解析，不放学科算法。
- `src/subjects/math/probe-quality.ts`
  - 只组合数学验证器，不写中央 switch。
- `src/subjects/math/probe-validators/unit-conversion.ts`
  - 复合单位分母变换验证器。
- `src/subjects/math/probe-validators/unlike-denominator-fraction.ts`
  - 异分母分数相加验证器。
- `src/server/agency/conjecture/probe-quality.ts`
  - 在通用结构门之后、LLM reviewer 之前调用解析到的 subject validators；只消费公共接口。
- `src/core/schema/business.ts`
  - 新增版本化 `subject_validator_results`；保存 validator id/version、适用性、判定、失败码和确定性证据。

接口结果只有三类：

- `not_applicable`：这份合同不是该验证器负责的模式；不能据此 pass，也不能阻塞其它学科。
- `pass`：验证器成功证明触发条件和目标错误签名都成立。
- `fail`：模式适用但题目不可解析、触发条件丢失、gold 错误或目标错误答案对不上；失败关闭并触发整包重生成。

不能把“解析不了”默认为通过。只要已识别为该验证器负责的模式，解析不了就是 `subject_validator_ungradable`。

### 4.3 复合单位分母变换验证器

输入限定为验证器明确支持的文本/符号形式；不尝试理解任意自然语言。

步骤：

1. 从两道题提取 source quantity、target quantity、分子单位、分母时间单位和倍率；
2. 确认 source 与 target 维度相同；
3. 确认每道题的分母时间单位真的发生变化，否则 `unit_denominator_trigger_missing`；
4. 用有理数倍率计算 gold，检查 `reference_md` 的数值与单位；
5. 按“只换分子、不换分母”的冻结错误规则计算目标错误答案；
6. 比较 `expected_target_error_answer_md`，不一致则 `unit_target_signature_mismatch`；
7. 两道题还必须使用不同的单位对或不同的表达形态，避免只换数字。

停止条件：遇到未支持的单位、含糊题意或多个可能 gold，直接 fail，不让 LLM reviewer把它补成通过。

### 4.4 异分母分数相加验证器

步骤：

1. 解析两道题中的两个有理数操作数；
2. 确认每道题的两个分母不同，否则 `unlike_denominator_trigger_missing`；
3. 用有理数运算计算唯一 gold，并与 `reference_md` 对齐；
4. 用冻结错误规则计算 `(a+c)/(b+d)`；
5. 检查它与 `expected_target_error_answer_md` 一致且不同于 gold；
6. 第二题必须改变情境或表征，例如从纯符号变成配比/长度情境，而不是只替换数值；
7. 若题目是混合数、多步应用题或存在多个运算意图而当前 parser 无法唯一判定，fail closed。

### 4.5 schema 与迁移策略

1. `probe_quality.schema_version` 升级，新增 `policy_version` 与 `subject_validator_results`；
2. 新生产的、被 math validator 判定为 applicable 的 proposal 必须保存对应版本的 pass 结果；
3. 历史已接受记录保持可读和幂等；历史 pending 记录不能用旧 audit 接受。只有在
   reprepare command 已真实上线时才自动重新准备，否则像 P0 v1/v2 升级一样，用
   agent-authored correction 退出 pending，等待新证据生成新 proposal，绝不能留下
   永远 409 的死卡片；
4. validator 版本变化产生新准备版本，不能覆盖旧题与旧审计。

### 4.6 测试矩阵

单元测试至少包括：

- 单位：km/h→m/s、m/s→km/h、分母未变化、维度不匹配、错误倍率、含糊单位、目标错误答案碰巧等于 gold；
- 分数：真异分母、同分母伪 follow-up、gold 错误、`(a+c)/(b+d)` 签名错误、目标错误碰巧约分后等于 gold、多步题不可解析；
- 每个通过 fixture 做 mutation：只改分母、gold、目标错误答案、context/representation 中任一项，必须转红；
- registry：未知学科/未知模式为 `not_applicable`，不能误阻塞语文等其它科目；
- pipeline：P1 fail → 一次整包重生成；第二次 fail → abstain；operational failure 仍走重试；
- accept：缺 validator provenance、版本过期、伪造 pass、题目后来被替换均 409。

### 4.7 质量评测与发布

1. 只 mock 输入证据包；输出必须走真实 `MindModelInductionTask → Author → Reviewer → deterministic validator`；
2. 固定包含两类已知反例和一组应通过样例，验证旧失败可以稳定被拦截；
3. 先 shadow 记录“LLM reviewer 通过但确定性 validator 拒绝”的分歧，不影响现有 P0；
4. 人工检查分歧，确认 parser 没有误杀后再把 P1 切到 blocking；
5. 任一严重事实错误漏过，或 validator 对支持语法出现误杀，关闭 P1 blocking flag，P0 继续工作；
6. P1 是否进入 canary 不依赖真实 owner 数据；mock-input/真实-output 可以完成开发验收。真实 owner 数据只决定是否扩大自动干预，不再阻塞实现。

## 5. 完成定义

### P0（本次）

- 新归纳不再携带题目；
- claim + DiagnosticSpec 一起形成共识；
- author/reviewer 独立、同模型、同证据；
- 一次整包重生成；两次质量失败 abstain；operational 不冒充质量反对票；
- nightly/director/accept 三个入口均不能绕过；
- proposal 保存完整 lineage 与审计；
- 定向 unit、DB、typecheck、Biome 通过，完整 gate 由 GitHub Actions 执行。

### P1（未实施）

以上数学确定性验证器、schema v2、shadow/blocking 发布步骤均只在本文件中规划；本次代码不包含它们。
后续实施由 `YUK-822` 跟踪。
