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

原生tighten只登记knowledge→ai12→10、practice→ai50→49、total387→384；39历史changes原entry字节前缀全保→41，其他分类字段不变。父仅恢复native重排的历史entry键序，JSON语义同native；不以此数字作为目标或并行收益。最终门待新源码复验，旧失败raw保留。
tests/DB/TEST/Docker/provider/runtime均NOT_RUN。首次独立R1与exact-head CI尚未执行。
