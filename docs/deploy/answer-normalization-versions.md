# 答案归一化版本的部署与回滚

判分服务必须保留已经发布的版本解释器。本文对应填空文本、legacy text_key 和 numeric 答案的兼容折叠修复，不授权迁移或重跑存量。

## 新键与旧键

- 新文本 blank 使用 `blank-norm@2`；新行级 text_key 使用 `answer_head@2`，铸键与判分均只折叠全角 ASCII/全角空格，保留其他兼容符号的区别。答案头与最终结论提取使用同一个版本。
- 新 numeric blank 与 numeric_key 显式携带 `normalization_version: numeric-norm@2`。草稿编辑往返保留旧版本；缺字段的冻结 revision 与显式 `numeric-norm@1` 维持旧行为。可选字段不设 schema 默认，不给旧对象补字段；新版本属于 scoring_basis，参与 digest/seal。
- 旧 `answer_head`、旧 blank normalization 字符串、缺 numeric 版本的 revision 均不会被部署自动升级。旧碰撞仍可能满分，存量修复须另行授权并产生新 revision，历史判分重放继续使用原 revision。
- 新 numeric 中 `5²` 等不支持的兼容字符保留为不可解析（pending），不会因 NFKC 变为 `52`；legacy numeric 新键依原始 raw_input 判分，不信任已经有损转换的 value。缺原文同样不可解析。显式数学等价仍属其他声明契约，本次不提供通用数学等价或别名推断。

## 回滚前必须知情

**已经有 @2 revision 在服后，不能把回滚到旧代码当成判分语义安全的回滚。** 旧代码的 blank normalization.version 是自由字符串，读到 `blank-norm@2` 不报错，仍按全量 NFKC 判分，兼容字符碰撞会重新放满分。numeric 版本字段也可能被旧 schema 丢弃，退回旧读法；旧 text_key schema 则不认识 `answer_head@2`，可能拒绝契约而造成不可用。

代码无法约束已回滚的旧二进制。回滚负责人必须在执行前了解新版本题的在服范围，以及错放回归/不可用的影响。需要回滚其他功能时，应使用保留这些版本解释器的修复版本；若仍选择完整回滚，必须由负责人知情裁定新版本题的服务处置，不能默认为安全。本次未执行回滚、撤题或部署。

## TEST 已知存量（协调线只读计数，2026-11-05）

- blank_key：3 个 revision，含兼容字符 0。
- text_key：accepted_texts 已可能有损，不能据此判无影响。按 question.reference_md 查，admitted 6 组中 1 组、withheld 41 组中 3 组含此类字符。
- numeric 单元：4 个。

以上 4 组文本存量在另行授权的存量重跑时换新版本。协调线已说明 TEST 没有真实学习者，该已发题不单独撤回；这些事项属于 Owner 真实开始使用前的存量清单。本次没有重跑存量，也没有把这些计数作为当前数据库重新查询结果。
