# Embedding 输入与指纹职责归属（YUK-1570）

Base：`214ecb0ef1c2d746316af5831ea79bbaa18345ef`。完整57行纯算法从
`src/server/ai/embed-source.ts` 原样迁至 `src/core/embed-source.ts`，旧真身删除。
四个出口和私有helper、6000 UTF-16截断、原字符串过滤/join、SHA256与版本2均保持。
七个真实consumer只改import目标及必要排序；无shim或新增包装。

消费者：`scripts/embed-inventory.ts`（动态import原位置）、knowledge的
`proposals.ts`/`tag-knowledge.ts`、practice的`jobs/embed_backfill.ts`、server的
`ai/solution-generate.ts`/`orchestration/nightly-signals.ts`/`questions/write.ts`。
inventory直接从已有core动态import读取版本；backfill旧版本转出删除，其余间接consumer保持。测试没有旧模块import pin，未改测试。

## 目标与实际收益

按owner最新目标，本片只记完整纯职责归属收益，不以边数下降或归零作为完成目的。
caller原已调用小接口，算法知识和调用步骤未减少。两个源码推演场景：
新支持一种输入文本字段需改文本构造与版本规则，旧功能维护调整截断/指纹规则也在
同一个owner内；迁前后均1文件。字段schema/图domain解析/失效写入仍需各自owner协调，
不能据此宣称已证明大量需求能并行或零返工。无实际新功能或规则行为变更。

五标准：完整责任是文本构造/截断/版本/指纹；接口四出口原样；隐藏知识未新增；
修改局部性1→1；行为证据为原字节及caller全文保护，运行效果不作推断。
provider/paid、effective-domain图读、事务/CAS/恢复/embedding写入失效正文不动。

## 写入权与证据

六consumer先获主线精确占用确认。第七`questions/write.ts`由总协调明确允许父在
隔离树只改import及必要排序；#1935也改该文件注释，但固定29f9的import未变。
外部writer身份UNKNOWN，不宣称作者释放或同意；不进其树、不改其PR/正文/注释。
谁先合另一片均normal merge保两者；真实新重叠再裁定。

作者dirty候选diff SHA：`b16f009d8f64415db73a7bf086cb305fdaefb5561decaba22a9e179d3d282ad7`。
父129seal全匹配，完整算法同字节、六caller排除import全文同；最终第七同样证明。
仓外：`architecture-deepening/YUK-1570/214ecb0ef1c2d746316af5831ea79bbaa18345ef/embedding-source-owner/`，
作者包`20261021T113639579649Z/`、父`parent-prepared-acceptance-20261021/`和
`parent-atomic-exit-20261021/source-proof.json`；旧seal保留。

父唯一frozen install通过且依赖三hash不变。首轮typecheck/lint/build通过；boundary仅实测下降待登记，architecture另发现原backfill版本转出的新目标站点。总协调批准最窄两文件收口：inventory把版本binding移至已有core import，保两await/模块加载顺序；backfill仅删旧export，排除这些binding/出口后全文一致，无新stable/compat。

原生tighten只登记knowledge→ai12→10、practice→ai50→49、total387→384；39历史changes原entry字节前缀全保→41，其他分类字段不变。父仅恢复native重排的历史entry键序，JSON语义同native；不以此数字作为目标或并行收益。最终源码 `370c7bdc19a635af1e93c69e38070e0fa788a4e9` 五门经heavy串行全部rc0；两audit固定base214，旧失败raw保留。实测384/0/36、SCC1（三成员）、超长12、新边0、pass-through1086（+0 new），只作诊断。依赖未重复安装，三hash同唯一安装回执。
tests/DB/TEST/Docker/provider/runtime均NOT_RUN。首次独立R1与exact-head CI尚待；父将以最终完整diff交首次R1，不拆出绕审。

最终源码及七caller保护：`YUK-1570/370c7bdc19a635af1e93c69e38070e0fa788a4e9/embedding-final-proof/proof.json`；五门raw/argv/UTC/rc在同head `embedding-final-gates/`。原获批出口收口patch SHA `be9304bcdf4e3733e7133befd12a9c98646b057c6323ffc8863cf18ec7acb64d`，9cbc相对证据保留。


## 已审片整合最新main

#1935/1937/1938注释片先合至main `102e77e42983155600fa31849d121d8c844b19b0`。
正常merge得 `7d505f163e0f537d9cbd3c85a699f21b9ff8a809`，无冲突；4477个其他main
条目全部保留，本片除write.ts外完整blob同唯一R1已审53cf。write.ts排除本片import后
全文同新main，保上游注释；完整Babel AST与TypeScript去注释JS emit同已审write。
裸TypeScript scanner初比rc1：未由parser重扫模板尾，误把SQL模板后注释吞为模板token；
首差为old161/new122 Editable surface注释。失败原留，已撤回提前发出的nontrivia相同
断言；采用定位上下文+完整解析及emit证明，不声称运行行为或错误栈行号不变。

新组合五门按base102经heavy串行全rc0，依赖三hash同原安装回执，未重复安装。
上游main账目原样，本片39→41历史前缀保持；诊断384/0/36，新边0、SCC不变。
唯一R1仍为214→53cf，未重开审查；本次是已审片与上游注释的组合证明，需新exact CI。
证据：`YUK-1570/7d505f163e0f537d9cbd3c85a699f21b9ff8a809/embedding-main102-integration/`
含五门raw/argv/UTC/rc、整树/账本/依赖proof、裸scanner失败定位、AST与两份emit。
这对真实变更成功在同文件不同hunk组合且无产品修复；不能外推任意需求并行零返工。
