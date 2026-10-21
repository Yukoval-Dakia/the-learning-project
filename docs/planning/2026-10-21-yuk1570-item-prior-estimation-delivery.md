# 冷启动题目先验的确定性解释与合成（YUK-1570）

本片服务已授权架构深化。完整算法与真实 consumer 已接线，旧三个算法 owner 原子退出，
零 shim/compat；不宣称学习效果、默认 DBOS 切换或运行验收完成。

基点 `204b9ae50352db4f539069790ed866350ce9d4a2`，分支
`arch/yuk-1570-item-prior-estimation`，实际树
`/Users/yuqi/.t3/worktrees/the-learning-project/t3-3838f87b`。
初始 HEAD 落后 fresh origin/main 60 提交，已从该 main 新建分支，未带父 docs 历史。

## 完整职责与 caller 少知

`src/core/item-prior-estimation.ts` 拥有完整 JSON barrier、LLaSA 1PL 网格反推、
median/代表 rep/provenance 算法。只依赖 core schema 与内建；schema 的外部依赖仍为 zod。
原 AI parser、core LLaSA、core reps 三文件删除。真实一参数解析实现
`parseItemPriorOutput(text)` 直接导出；无第二个 LLaSA 测试 shim。

- retained feature 的两次解析位置与最终合成、retained LLaSA 的解析，消费新 owner。
  LLaSA caller 不再解包 `.prior`；runner 分支、单次/多次执行、await/catch/warn/source 保留。
- staged 解析只调 `parseItemPriorDraft(method,text)`，不再选择解释器或解包诊断形状；
  成功集合只调 `aggregateItemPriorDrafts(method,drafts,intendedReps)`，不再选择首份/median。
  held/pending/no-anchor、成功集合收集与能否合成仍由原 caller 决定。
- paid adapter 仍从 immutable output 重新 parse/settle 并逐字比较历史 application，整 blob 不变。
  TaskSpec 的另一套 `parseText` 契约、public/manifest/family/schema/DB/mastery 不动。

两个真实维护场景：文本解释与 LLaSA 诊断演进，原分散在 parser、反推与 caller 投影，
现由一个 owner 承担；成功集合策略演进，原分散在 median 与 retained/staged 选择，
现集中在同一合成入口。方法参数和执行/付费知识仍留 caller，不声称整条标定链被隐藏。
五标准：完整责任；两个窄生产入口；隐藏上述选择和结果形状；两个场景修改局部化；
行为证据只计本轮实际源码比较，不预付 main 图指标或 runtime 收益。

原五个算法函数除私有化 `export` 外逐字相等；完整常量/类型段匹配。
planned>1 仅成功一份仍保留原 median provenance；retained 全失败仍原错误穿过 catch/skip，
staged 空集合仍在调用前 no-anchor。原 JSON/数值网格/tie/reasoning/错误类型与消息不变。
operation 全部变更只在已释放表达式/import；14 个受保护函数全文不变，complete-before-parse 保留。

## 精确测试批准

owner 本次原话（父同线程转达，2026-10-21）：

> 批准该精确 import 改动

已核批准 patch SHA256
`561d59c268aa19e37656960dea374d098dcf1899eefd0cace7b916d8b8531b4b`，
测试前像与基点、ea000 固定对象均一致后应用。唯一改动为
`item-prior-durable-operation.unit.test.ts` 的 `parseItemPriorOutput` import：
旧 `@/server/ai/item-prior` 第19行 → `@/core/item-prior-estimation` 第12行。
第298行一参数调用、数据、断言、用例不变；删除旧/新该 import 行后全文 **IDENTICAL**。

- 测试前 SHA256：`92e87653f92e8a48dbe945a32a7a9a2f75d04d13cea5e10f1b6f2121f3a5cbce`
- 测试后 SHA256：`5a38d431d998b2929b6bdca5bdd50a709ea7456a1bf6ced7657eefbfe50cc002`
- 排除该行后的共同 SHA256：`43fa4161630e586ddcecae91e19ff1fb44b2a0dbf830addbdcfd4e75ecd61fff`

## 证据与父接管

外置根为 `/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1570/204b9ae50352db4f539069790ed866350ce9d4a2/`：
`item-prior-estimation-candidate/` 封存原产品 diff、完整 caller、两场景、五标准、逐函数/保护段及依赖 hash；
该旧 seal 和当时测试待批状态不覆盖。当前批准、测试双边 hash/同一性、最终 diff/commit/原始 argv/UTC/rc
另封 `item-prior-estimation-approved-delivery/`。

作者源码交付时缺 node_modules，未自行安装或运行门；该历史记录与旧 seal 保留。
父普通合入 main `ea21d2f60ba2b212d88c5d596f2e62fdd4810ff9`（#1802），
组合源码 `d62e8de05e0e258ee863dfbea554a48ee265f1c0` 无冲突，七条本片路径及所有其他 main 条目保留。
父唯一 frozen install rc0，package/lock/workspace 三 hash 前后相同；其后 heavy.sh 全机两槽、本片串行：
typecheck/lint/build rc0（lint 181 warnings）；首轮两 audit 仅报实际下降待收紧，红日志保留。

原生 --tighten 实测 practice→AI 51→50、总数388→387；上游389→388不计本片。
原生工具重排了 main 最后一条 knowledge→AI decrease 的键顺序，父仅恢复其原字节，
不改变任何原生度量值或新增记录。main 38条 changes 的逻辑及原始 entry 前缀全保留，
仅追加本片1条；其他账本字段不变，无新stable/compat/白名单。
最终账本源码 `97c82f47ec9be9c2367d23c04755a1d999ab8ad9` 的 baseline格式、两 audit 全rc0，
后续仅更新本文件，产品与已通过 type/lint/build 的 d62 完全相同。
实测387/0/36、SCC1×3、超长12（base12）、new edges0、pass-through1087/+0new。

父证据位于同一仓外 YUK-1570 根下：`63767d1066a4525fb658a2007ebd79e8e318b5d5/parent-takeover/`；
`d62e8de05e0e258ee863dfbea554a48ee265f1c0/{parent-source-proof,parent-frozen-install,parent-five-gates,parent-native-tighten}/`；
`82c6e976f55449102822cc37c7210182ec40bfe4/parent-history-order-preservation/`；
`97c82f47ec9be9c2367d23c04755a1d999ab8ad9/parent-final-audits/`。
父独立 AST 核14个原声明逐字迁移、35个operation留守声明不变、9组diff只在批准hunk；测试删唯一import后全文同。
旧路径在受保护 tasks/schema 的注释及TaskSpec说明文字仍有3处，均非代码引用，本片未扩大到这些内容。
所有本机 tests/DB/TEST/Docker/daemon/provider/runtime/demo/paid 均 NOT_RUN；测试批准不扩大运行范围。
唯一独立 R1、PR/exact CI由父继续推进，未把本地门通过当成运行或main收益。
