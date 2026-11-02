# Frontier 两个站点：协调线逐项裁定

YUK-1579 / PR #1895。分类机制已获协调线批准，依据提案
`c89165fcb0265173fbaef102b78f34a9b883dbb5b40f26c93c0b1965875dcede`。
**协调线已逐项批准下述分类（原材料 commit30ffe7568）。**
裁定回执：[YUK-1579 原票记录](https://linear.app/yukoval-studios/issue/YUK-1579#comment-af8190bd-7e93-4133-ba02-68a844f006fc)。
这是协调裁定的父线转录；实现中五字段与单符号限制须逐项保留。
固定历史源码 `de061af07afece563d0f350a5e101a3e395c6c58`（已合 #1837）。
新机制只处理新增站点；这两个历史站点不因本记录获得新豁免或新期限。

## 站点一：knowledge 的稳定决策出口

- **owner**：knowledge，拥有先修闭包与可学习前沿决策。
- **目标符号**：`src/capabilities/knowledge/public.ts:71` 导出的
  `learnableFrontierResolved`，解析目标
  `src/capabilities/knowledge/server/frontier-read.ts:220` 同名函数。
- **真实 consumer**：
  `src/capabilities/practice/server/learnable-frontier.ts:5` 导入，
  `:26–27` 实际调用并取 `.ids`。此调用不是自引用。
- **源码证据**：目标 `:220–278` 拥有有界递归查询，
  `:280–314` 拥有溢出与稀疏状态，`:324–352` 拥有掌握门、排序和稠密结果。
  practice 只传 Db/Tx、取结果，不掌握查询、探针及排序顺序。
- **为何稳定、不是兼容中转**：这是实现 owner 暴露完整决策的正式边界。
  改掌握/溢出规则只改 knowledge 实现；新增消费者也复用同一决策。
  public 不复制实现，不要求消费者依赖内部文件。强制该出口退役会破坏此边界。

协调裁定：**稳定公开契约**，不设 14 天期限；仅该符号该目标，
不连带批准 `isMasteredForFrontier`、其他 alias 或整个 public 文件。

## 站点二：practice 的旧同名再导出

- **owner**：真实决策 owner 仍是 knowledge；practice 仅保有旧绑定。
- **目标符号**：
  `src/capabilities/practice/server/learnable-frontier.ts:9` 再导出的
  `learnableFrontierResolved` → `src/capabilities/knowledge/public.ts` 同名符号。
- **consumer 事实与限度**：
  `src/capabilities/practice/public.ts:59–62` 保留该旧再导出绑定。
  本轮未证得它之后的真实运行调用，不能把这条转出本身冒称最终运行 consumer。
  同文件 `learnableFrontier` 的 `.ids` 调用使用的是直接 knowledge import；
  `stream-inputs.ts:35` 消费的是 `learnableFrontier`，不是本条同名再导出。
- **源码证据**：practice 文件 `:5、:9、:26–27` 与 public `:59–62`；
  knowledge nightly 已在 `:51–54` 直接消费本域实现，不能算旧口消费者。
- **为何不是稳定契约**：此符号没有 practice 决策责任，只保持旧导出地址。
  不能因它位于 public 的转出链而升级为永久契约。

协调裁定：**兼容中转类别，非稳定契约**。作为 base 存量不追罚；
若以后新增同类口，必须另证真实旧 consumer、退出条件、Linear 票、
协调批准与最长 14 天期限。当前材料不足以签发一个新的 compat 例外；
不伪造截止期，不在本片删除旧口或修改测试。

## 校验与审批边界

父线只做固定源码 `git show/grep` 核验。原有历史 audit 日志在分类提案中；
新分类实现及获批正例执行尚未完成，不把当前 `+0 new` 当分类验收。
原三个新 P1（worker 入口、拆分 alias、自引用 consumer）由原作者同步窄修。
独立审查预算不重开全 PR 第三审；按本次授权只补核新增分类语义。
测试、DB、Docker、provider、runtime 均 NOT_RUN。
