# 干预诊断有效结果读取归属（YUK-1571）

Owner 明确授权的架构切片：三条完整 reader 从 practice 写协议文件迁入
`kernel/read-models/intervention-diagnostic-verdict.ts`，真实 consumer 同步改指，
删除 practice/public 两个旧读出口。无 shim、registry、DI 或新 stable/compat 分类。
本片只处理诊断读，不重做 active-goal、资产职责或扩展测试。

## Revision 与证据

- base：`83bbecdaecaf70be0ae0241795fac3d5a07940c1`。fetch 后
  初始父旧 HEAD `c338877f86cc9642340abea36b65153a978eadc1` 落后 origin/main
  38 commits；新分支从 origin/main 创建，未带入父旧 docs commits。
- branch：`arch/yuk-1571-intervention-diagnostic-readers`；唯一 writer 树：
  `/Users/yuqi/.t3/worktrees/the-learning-project/t3-e13621b0`。
- source head：`9fca3640303ff7f935e9e468313376b08dd618eb`；source tree：
  `32f640cbafeb0c43ff944bf4aedd6a5c308fba2f`。本交付文档随后单独提交。
- 外部证据根：`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK1571/9fca3640303ff7f935e9e468313376b08dd618eb/diagnostic-read/`。
  `source-proof-v2/source-proof.json` SHA256：
  `8a79c81eb94f0092933c72e791fc6629934573c7fe75c2a962b40fc363241add`；
  `SHA256.json` SHA256：`65e46c129f6008af8435c4937c6dea313afd22aaca902031a858e14b22916334`。
  raw stdout/stderr、argv、UTC、真实 return code 与源文件摘要均外置。

## 全部直接 caller 与知识变化

| reader | 真实 caller（base 行号） | after |
|---|---|---|
| LatestTrusted | practice `loadCommittedInterventionDiagnosticAttempt`:363；agency `settlement-subscription`:95 | 两者直引 kernel；前者不再调用本文件定义，后者不再经过 practice/public |
| NativeState | practice `loadCommittedInterventionDiagnosticAttempt`:318；agency `store`:559–562；原 NativeVerdict:275 | practice 与 agency 直引 kernel；NativeVerdict 随实现同迁 |
| NativeVerdict | 无外部 caller | 保留原有函数与 trusted-filter 行为，不新增 barrel 出口或虚构 consumer |

调用参数、返回字段、错误传播、顺序与 consumer body 不变。Caller 原本就不知道
候选 SQL、纠错链和 native 关联细节；本片没有新增这部分知识隐藏。变化仅是读职责
owner/import seam；agency 不再为这两条读取加载 practice 公共面。

检索证据：Serena 三符号 references、tracked git grep（base/head）、rg -uu 全树
精确符号检索互相核对。没有直接导入三 reader 的测试。
`agency/server/intervention/intervention-preparation.db.test.ts:75` 导入真实 subscriber，
调用在 971、1014、1269、1335、1365、1466、1546；文件与 case 均未改、未运行。
`scripts/capability-public-read-cycles.ts:78` 仍记录旧 LatestTrusted 名，属于审计
catalog，已报父；本 lane 不改 audit。代码索引返回 not ready，未以空索引证明无 caller。

## 五源码路径的保护证明

| 路径（省略 src/） | 唯一允许变化与实核结果 |
|---|---|
| `kernel/read-models/intervention-diagnostic-verdict.ts` | 三 reader 正文与 base:148–277 逐字一致（仅文件末尾空行不同）；共142行，没有重新定义 schema、错误类或 clone 返回对象 |
| `capabilities/practice/server/intervention-diagnostics.ts` | 删除迁出段，移除只供 reader 使用的 z/JudgeOnEvent/resolver import 并绑定两 reader；其余字节一致。acceptedDiagnosticOriginal、committedDiagnosticAttempt、loadCommitted 全文一致；appendImmediate 起至 EOF 整段一致，包含 materialize、retire、锁、claim、恢复与发布/撤销 |
| `capabilities/agency/server/intervention/settlement-subscription.ts` | 仅一个 reader import 更换来源并按原导入分组排序；删去该 import 后全文与 base 相同 |
| `capabilities/agency/server/intervention/store.ts` | 仅 State 动态 import 字符串变更；仍在 learning-state lock 与 correction advisory lock 之后、同 tx/原调用顺序，其他字节相同 |
| `capabilities/practice/public.ts` | 仅删除 LatestTrusted/NativeState 两读出口；所有命令、其他 type/value 出口一致，NativeVerdict 从未由此导出 |

历史 reader 保留 `(created_at DESC,id DESC)`、50 条界、active correction、
`multimodal_direct`、invoked/supplied_verified provenance、反馈 null 规则。
Native reader 保留 immutable original learning_scope、original question metadata、
effective head、activation 的 evaluation/generation/group/submission 关联、非诊断替换、
trusted=false 与 null 区别，以及原纠错事件作为 verdictEvent 的行为。
继续使用同一 core schema 对象、getEventById、assessment resolver 与 DB schema 绑定；
对象引用与异常传播由未变正文支持，未做运行时对象身份验收。

## cap → kernel 来源与闭包

- practice/intervention-diagnostics 静态 import：LatestTrusted、NativeState。
- agency/settlement-subscription 静态 import：LatestTrusted。
- agency/store 原位置动态 import：NativeState。
- 新模块值依赖：drizzle-orm、zod、core/schema/event/known、core/schema/intervention、
  db/schema、kernel/events、kernel/read-models/assessment-verdict；Db/Tx 为 type-only。
- 静态 ESM 值依赖遍历：83模块/203边，未发现 cap/server 反向值依赖或未解析本地
  import；完整列表在 `source-proof-v2/value-closure.json`。这是源码佐证，非官方 audit。

## 两个真实维护场景

1. 调整历史可信判分候选的 provenance/排序规则：before 改 practice 的混合读写文件，
   after 改 kernel 的完整 reader；前后均一个实现文件、两个真实 caller 都无需改动。
   改善是审读范围与写协议分离，没有减少原本就单点的修改数量。
2. 调整 native 冻结 scope 与 activation generation 对应的读取规则：before 与
   materialize/retire/claim 共文件，after 改 kernel reader；前后同样单点修改。
   State/NativeVerdict 共用实现，两个 State caller 保留原参数和锁知识；caller 的
   锁顺序、trusted=false/null 处理并未因本片消失。若涉及 writer 协议/冻结 schema，
   仍需另外协调真实 writer/schema，不能宣称这些契约可独立演进。

## 五标准与验证限度

- 责任：kernel owns 跨 practice/agency 共享诊断结果读取；写/结算/锁仍归原 owner。
- 接口：三个既有函数签名/返回不变，两个实践公共读出口删除；没有新增承诺或适配层。
- 隐藏知识：既有 SQL/判定内部知识保留；caller 只改变 import owner，未新增算法深度。
- 修改局部性：混合文件827→698行，新读模块142行；两个场景的修改文件数均不减少。
- 行为证据：13项源码比对全部通过，正文/保护段 digest 外置；`git diff --check` rc0。
  初次采证进程 rc1 源于 rg 继承 stdin 未给搜索路径，源码比对全过；修正显式 `.` 后
  v2 rc0，原始失败 raw 保留。未运行产品逻辑或测试。

node_modules 缺失；本 lane 未安装/更新/复制依赖。typecheck/lint/build/两 audit 全为
NOT_RUN（不是绿色），父串行一次 frozen install 后仅经 heavy.sh 执行并封存真实结果。
本机 tests/vitest/DB/TEST/Docker/daemon/provider/runtime/demo/paid 全部 NOT_RUN；
没有 push/PR/watch/review/Linear/清树。audit catalog/baseline 更新、exact-head CI、
独立审查与 Linear 状态归父。本 lane 不自改 baseline、不报告 SCC 减少或官方计数收益。
