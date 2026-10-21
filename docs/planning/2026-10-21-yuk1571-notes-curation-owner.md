# Notes hub 策展归属交付

Refs YUK-1571，承接父方 `2026-10-20-yuk1571-notes-curation-ownership.md` 的候补片授权。
服务「帮助靠谱」的 notes 政策归属契约；仅本片源码完成，不核销架构整票。
基准 `9173b0291cbff0beebcfd0bc4f177ea7004c763f`（fetch 后最新 origin/main），
分支 `arch/yuk-1571-notes-curation-owner`，独立树
`/Users/yuqi/.t3/worktrees/the-learning-project/t3-51c6ab27`。未带入父树旧文档。

## 实际差量与消费者

- `kernel/hub-mesh.ts` 整 blob 原样迁为 `notes/server/hub-curation.ts`，零 wrapper/barrel/shim。
  原声明顺序、签名、函数 body 及 8 导出全部保留：`HubMeshNode`、`HubMeshRelation`、
  `HubMeshEdge`、`HubMeshAtomicInput`、`HubMeshInput`、`CuratedAtomic`、
  `treeDescendantIds`、`resolveHubMeshAtomics`。
- 唯一 production value caller：`notes/server/hub-sync-reconciliation.ts:306`；
  算法 import 仅 `HubMeshAtomicInput`、`HubMeshEdge`、`resolveHubMeshAtomics` 三绑定，
  迁能力内并按既有 import 顺序排列。唯一外部 type caller：`hub-auto-zone.ts:4` 的
  `CuratedAtomic`，同迁能力内。两文件非 import 字节完全相同。
- Knowledge public 仅退出 `resolveHubMeshAtomics` 值与 `CuratedAtomic`、
  `HubMeshAtomicInput`、`HubMeshEdge` 三类型；其余 60 绑定、顺序、来源与正文保留。
  AST 实测 **64→60**，值 **44→43**、类型 **20→17**，export-star 仍 0。
- Knowledge 旧兼容模块 15 行、7 转出绑定，先核无 live consumer，再整体删除；
  kernel 旧真身同步退出。旧 compat **1→0**、public 策展出口组 **1→0**（4 绑定，
  不是 4 模块）。auto-zone 跨域类型路径 **1→0**。
- `audit-relations.ts:182/204/223` 三登记指向真实 notes owner；对应路径注释订正，
  markers 与判定 token 不变。`knowledge-graph.ts` 仅首两行归属注释订正，完整图读保留。

固定 base 的全仓 `git grep` 与全部 2,360 个代码文件 AST 交叉核 import/export、
namespace、import-type/import-equals、dynamic import、require/resolve、mock 和测试路径 pin。
符号只落旧算法、public/compat 及上述两 consumer；没有新消费者。唯一 public 动态加载为
`server/start/workbench-reader.ts:50`，解构 `loadTreeSnapshot`，不消费退出绑定；无目标
namespace/export-star。两个非字面量加载分别是历史视觉原型 THREE_URL 与历史取证脚本
的 Babel parser require，不指向本片。扫描包含测试源码，未运行或修改测试。
历史 docs/记账路径保留；不以全仓字符串零命中充当旧口退出证据。

## 两个维护场景与五标准

1. 改变笔记纳入/排除关系：原修改 `kernel/hub-mesh.ts` 的过滤与匹配规则；现在同样
   只改 `notes/server/hub-curation.ts`。审查语境随 notes 政策归属，caller 仍只传窄输入；
   不减少算法修改文件数。本片不开放 `related_to` 或任何新关系。
2. 调整 strongest relation 优先级：原改 kernel 的 `RELATION_PRIORITY`；现在改 notes
   同一常量。chip 结果仍由原调用链消费；两个 caller 均不需新顺序知识。本片不调优先级。

- 责任：notes owns 纳入/排除/优先级纯政策；kernel 保留完整跨能力图读；claim/finalize/
  recovery/suppression 与 paid/事务时序仍在原 owner。
- 接口：8 导出与纯函数输入/返回原样，移除 knowledge 的 4 个无须跨域公开绑定，无新层。
- 隐藏知识：算法原已封装，caller 算法/顺序知识不变；不宣称新增算法深度或消环。
- 修改局部性：两个场景仍各改一个算法文件，收益是与 notes 产品责任同域以及 public
  实质收窄；server/cross-value/SCC 预测持平，未跑 audit，不预付指标收益。
- 行为证据：整 blob SHA256 相同，纳入排除、priority、subtopic 全包含、descendant、mesh
  方向、localeCompare + id 排序、空值/错误/identity 原样。consumer 非 import、graph
  首两行外字节、其余 public、audit 规范化路径外字节与全部逻辑 token 对照均通过。
  fresh-per-claim、锁/CAS/恢复/事务等只证明源码未变，不冒称运行验收。

## 验证与交接边界

`git diff --check` rc0；静态 AST/hash 证据 rc0。AST 仅只读加载父树已存在的 TypeScript
6.0.3 parser（绝对路径与文件 SHA 记入证据），不加载产品模块。父树 package/lock/workspace
与本树不同，未将该 parser 当本树工具链或项目门，不安装/更新/复制依赖。
首轮静态证明脚本 rc1 是审计语句比较误含已授权路径注释；改为跳过 trivia 的 token
比较后通过，原失败 stdout/stderr/argv/UTC/rc 保留，不属于产品门失败。

父方在 writer 停止后完成唯一一次 `pnpm install --frozen-lockfile`，rc0；package/lock/workspace
三项哈希前后相同。安装回执在原交付 `8ef3213515c88de3276e6b74ca8099eb6330ffa8/parent-frozen-install/`。
父另删 `knowledge/server/AGENTS.md` 中已退役文件的一行目录说明，未改任何规则。

父受检 head `79751769b8a735f8910bb0cbfbd7bbbf6ef587a1` 的七门均真实 rc0：
typecheck、lint（181 warnings）、build、capability-boundaries、architecture-deepening、relations、hub-sync-writers。
两项架构 audit 的 base 均为 `9173b0291cbff0beebcfd0bc4f177ea7004c763f`；全部经
heavy.sh / HEAVY_SLOTS=2 本 lane 串行，raw stdout/stderr、argv、UTC、真实 rc 封存于
`architecture-deepening/YUK-1571/79751769b8a735f8910bb0cbfbd7bbbf6ef587a1/parent-seven-gates/`。

实测 server389/deep0/cross36、SCC1×3、超长12均与base持平；new dependency edges=0，
pass-through sites1087（+0 new）。baseline全文与base相同，未tighten、未改任何历史登记。
这不是新算法深度或消环；public64→60及旧口退出才是本片验收差量。
本文验证结果更新是门后唯一差异，产品/脚本/配置字节与受检head相同。

测试编写/修改/运行、DB/TEST/Docker/daemon/provider/runtime/demo/paid均NOT_RUN。
独立R1与exact-head CI由父后续单独记录；本地门不冒充CI或运行验收。

永久证据位于
`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1571/`
下本交付提交完整 HEAD 的 `notes-curation-owner/`。提交可由
`git log -1 --format=%H -- docs/planning/2026-10-21-yuk1571-notes-curation-owner.md` 精确定位；
父交接另列 literal HEAD/tree/path。`source-proof-sha256.json` 不含自身，SHA256
`1c6acc844aa7fdf06767ec0210d579a9ede348a109637bbd28e4cae96062d1c5`；最终
`checks-sha256.json` 也不含自身。原 seal 不覆盖；提交后 writer 停止，树保留。
