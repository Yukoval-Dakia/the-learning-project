# 答案归一化版本的部署与回滚

判分服务必须保留已经发布的版本解释器。本文对应填空文本、legacy text_key 和 numeric 答案的兼容折叠修复，不授权迁移或重跑存量。

## 新键与旧键

- 新文本 blank 使用 `blank-norm@2`；新行级 text_key 使用 `answer_head@2`，铸键与判分均只折叠全角 ASCII/全角空格，保留其他兼容符号的区别。答案头与最终结论提取使用同一个版本。
- 新 numeric blank 与 numeric_key 显式携带 `normalization_version: numeric-norm@2`。草稿编辑往返保留旧版本；缺字段的冻结 revision 与显式 `numeric-norm@1` 维持旧行为。可选字段不设 schema 默认，不给旧对象补字段；新版本属于 scoring_basis，参与 digest/seal。
- 旧 `answer_head`、旧 blank normalization 字符串、缺 numeric 版本的 revision 均不会被部署自动升级。旧碰撞仍可能满分，存量修复须另行授权并产生新 revision，历史判分重放继续使用原 revision。
- 新 numeric 中数值前缀的 `5²` 等兼容字符保留为不可解析（pending），不会因 NFKC 变为 `52`；legacy numeric 新键依原始 raw_input 判分，不信任已经有损转换的 value。缺原文同样不可解析。数值前缀 `5²`、`5² m` 不会丢失平方后给分；单位后缀保持既有 mathjs 兼容写法，`10 m²`、`10 cm³` 可按对应单位给分。显式数学等价仍属其他声明契约，本次不提供通用数学等价或别名推断。

## 数值精度与标点

`Number()` 会把离它至少 0.5 的字面量折进另一个浮点。这类字面量按有理数和键比较，不用折叠后的值。容差为 0 时，`9007199254740993` 和 `9007199254740992.5` 对键 `9007199254740992` 都判错。绝对容差和相对容差都按这个距离比较。带单位且系数同样被折走至少 0.5 时，不折成满分，结果是 pending。普通小数（如 `10.24`）和能精确表示的整数（含 `2^53`）仍按原容差比较。

文本空的 `ignore_punctuation` 仍去掉普通标点，但保留数字的负号（`-`、全角 `－`，含 `-.5` 和 `- 5`）和小数点（`.`、全角 `．`）。`-5` 不等于 `5`，`-.5` 不等于 `.5`，`10.24` 不等于 `1024`。词内连字符和句末句号仍按标点去掉。

这两条是判分读法的修正，不新增归一化版本，也不改 NFKC 与宽度折叠的版本分界。普通范围内的数值、未开启忽略标点的文本空，重放不变。

## 回滚前必须知情

**已经有 @2 revision 在服后，不能把回滚到旧代码当成判分语义安全的回滚。** 旧代码的 blank normalization.version 是自由字符串，读到 `blank-norm@2` 不报错，仍按全量 NFKC 判分，兼容字符碰撞会重新放满分。numeric 版本字段也可能被旧 schema 丢弃，退回旧读法；旧 text_key schema 则不认识 `answer_head@2`，可能拒绝契约而造成不可用。

代码无法约束已回滚的旧二进制。回滚负责人必须在执行前了解新版本题的在服范围，以及错放回归/不可用的影响。需要回滚其他功能时，应使用保留这些版本解释器的修复版本；若仍选择完整回滚，必须由负责人知情裁定新版本题的服务处置，不能默认为安全。本次未执行回滚、撤题或部署。

## TEST 已知存量（协调线只读计数，2026-11-05）

- blank_key：3 个 revision，含兼容字符 0。
- text_key：accepted_texts 已可能有损，不能据此判无影响。按 question.reference_md 查，admitted 6 组中 1 组、withheld 41 组中 3 组含此类字符。
- numeric 单元：4 个。

以上 4 组文本存量在另行授权的存量重跑时换新版本。协调线已说明 TEST 没有真实学习者，该已发题不单独撤回；这些事项属于 Owner 真实开始使用前的存量清单。本次没有重跑存量，也没有把这些计数作为当前数据库重新查询结果。

## 旧草稿 source_verify 的兼容重建

source_verify 比较行级投影与冻结 revision 时，按稳定 scoring_unit_id 读取该 revision 的 text_key normalization 或 numeric_key normalization_version。缺 numeric 版本仍保持缺失，不补 @1 或 @2。只重用版本政策，答案、分值、结构、单位等仍从当前行重新构造，并且必须通过原 seal 和完整 canonical 比较；改坏行内容仍不匹配。未提供冻结 basis 的新发布路径继续使用新版本默认。

这避免旧普通文本草稿（即使没有兼容字符）和旧 numeric 草稿仅因新版本上线而落入有损冻结投影、触发 unmapped_slot_kind/structure_completeness 失败。此修复不自动重发题、不推进核验、不重跑存量，也不保证其他形状问题通过。

验证在独立临时 Postgres 的真实 question/question_revision 表完成，旧契约由修复前固定源码 `b55162968^` 生成：普通旧 text_key、含上标旧 text_key、旧 numeric_key 三条均 legacyRowMatchesRevision=true；新默认重建均不匹配，改动答案/数值后仍不匹配。未执行 provider 核验。

2026-11-05 的一次越界只读查询（协调线之外，经容器内 `psql` 执行 BEGIN READ ONLY）留下的历史计数：当前 web_sourced + draft + withheld + 旧 text/numeric 版本共有 16 组，全部已有非 error 的 source_verify 终态事件；真正没有终态事件的旧版本草稿为 0。其他版本 draft/withheld 且无终态事件为 2 组。全状态 web_sourced 旧版本为 20 组，其中 active/admitted 3、active/withheld 1、draft/withheld 16；该快照无旧 numeric_key。终态事件按当前 source_verify 的幂等条件定义，不等于“核验成功”。因此当前无自动首次核验旧版本积压；显式存量 recheck 若选中这 16 组，仍需要本修复的旧版本重建。这不是协调线认可的最新库存，以存量重跑前迁移线的重查结果为准。未把这份历史计数臆测成历史 40 题重跑名单的交集或完成比例。写手不得连接或以任何方式读取 TEST 容器或数据库，需要数字时向 Owner 提出。

## 新门合入后的版本接线

新准入从冻结契约建立 definition 时，克隆作者 seed 并将文本配置版本设为 blank-norm@2、numeric 版本设为 numeric-norm@2；保留原答案、容差、单位及显式归一化开关，不改冻结原件。旧 text_key（含 answer_head）映射到新版本 blank 配置；行级新发布继续铸 answer_head@2。exact/trim 仍保留 nfkc:false 等设置，仅使用统一的新版本标记。

新门的 authorKeyAccepts 使用该克隆 seed 调用同一判分器；快路径 keysAgree 使用同一 unit.blank_normalization，跨 text/numeric 纯数字比较使用 numeric-norm@2。盲解快路径和裁决决定都汇入 criterionFromKey，再经同一判分核心执行探针；旧原件仅在 unresolved 分支保留，不能当作已准入新键。历史 submission 依旧按其冻结 revision 判分。
