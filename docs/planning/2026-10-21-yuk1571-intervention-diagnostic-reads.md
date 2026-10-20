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
- 初次源码证据根（历史目录 `YUK1571` 无连字符，原件保留）：`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK1571/9fca3640303ff7f935e9e468313376b08dd618eb/diagnostic-read/`。
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
父随后批准 `scripts/capability-public-read-cycles.ts` 的 practice→agency 项纯数据退役：
files 仅删 settlement-subscription，symbols 仅删旧 LatestTrusted 名；其余 files、
commands、TodayPlan 与 audit 逻辑全部保留。代码索引返回 not ready，未以空索引证明无 caller。

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

初交付时 node_modules 缺失，五门 NOT_RUN 的旧 seal 保留；后续结果见下。本 lane
未安装/更新/复制依赖。
本机 tests/vitest/DB/TEST/Docker/daemon/provider/runtime/demo/paid 全部 NOT_RUN；
没有 push/PR/watch/review/Linear/清树。baseline 登记、exact-head CI、独立审查与
Linear 状态归父。

## 普通整合 main 与五门实测

父在本树唯一串行 `heavy.sh pnpm install --frozen-lockfile` rc0；package.json、
pnpm-lock.yaml、pnpm-workspace.yaml 的三个 SHA256 前后相同，writer 已与本树实物核对。
回执为正确目录 `architecture-deepening/YUK-1571/411c2f7046c44e32290b8641b25ba1b7c1d155a9/parent-frozen-install.json`。

普通 merge `20222f2cafe1500a9e445b43fe132935405d825a`，merge commit
`0d2aa207e`，无冲突。catalog 两行纯数据退役提交 `d4bb539ab0b1f4891bd4ea82cfc015fcd6b41939`，
也是以下五门受检 head，tree `3ce30943ba3c384a021cc72c6e59a60d30038c9b`。
4455 个上游非本片文件 blob 全部相同，五源码 blob 仍与 9fca 相同；ledger blob
`9a0e9e53ae6dccaaf9eeebc934e0a898543a0348` 与 main 一致。无本片 import/format 修补。

五门均从本树经 `heavy.sh pnpm <script>` 串行执行，HEAVY_SLOTS=2；两个 audit 显式
`--base 20222f2cafe1500a9e445b43fe132935405d825a`。

| 门 | 真正 rc | 结果 |
|---|---|---|
| typecheck | 0 | 两 tsconfig 完成 |
| lint | 0 | 180 warnings；不宣称与 main 逐项相同 |
| build | 0 | web/Start/server/worker/migrate 构建完成，未启动产品进程 |
| audit:capability-boundaries | 1 | 仅两项债务下降 + 三条新 cap→kernel 边待父登记 |
| audit:architecture-deepening | 1 | 仅相同两项债务下降；无其他 finding |

实测 server/deep/cross 为 403/0/36；ledger cross37→实际36、agency→practice5→4。
唯一退出跨包文件边是 settlement-subscription→practice/public；store 仍有真实
materialize/retire 命令依赖，不能重复计算它。SCC 保持1×3{agency,knowledge,practice}；
超1500行文件13→13；新 kernel 反向 value/type 边0/0。

为从失败 audit 获取精确 symbols 与 counters，另经 heavy 串行执行 boundary
`--json --base 20222f2...`，真实 rc1，仍同五项。三条新边的目标均为
`src/kernel/read-models/intervention-diagnostic-verdict.ts`；source 前缀为 `src/capabilities/`：

| source | kind | scanner 实际 symbols |
|---|---|---|
| `agency/server/intervention/settlement-subscription.ts` | value | `[loadLatestTrustedInterventionDiagnosticVerdict]` |
| `agency/server/intervention/store.ts` | value | `['*']`（原位置动态 import） |
| `practice/server/intervention-diagnostics.ts` | value | `[loadLatestTrustedInterventionDiagnosticVerdict,loadNativeInterventionDiagnosticState]` |

本轮正确外证根为 `/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1571/d4bb539ab0b1f4891bd4ea82cfc015fcd6b41939/`：
`diagnostic-read-five-gates-v1/` 保存全部 raw/argv/UTC/rc、上游逐 blob 证明；
`SHA256.json` SHA256 `5195c761aac1218acaf10aae807b9edef4132786f3bcbabf157e6d1f790cbe6c`。
`diagnostic-read-dependency-facts/dependency-facts.json` SHA256
`c88f3ce9a16d24783057c85b5688c01aaa3f6ad2d65bec06c9ed4913d4b1d371`。
失败 seal 均保留；上述为登记前结果，当时 baseline 未改，后续授权登记见下。结果只对应
受检 d4bb；本节随后仅文档提交，终态由外部 delivery seal 绑定，不冒称新 head 跑过五门。

## 授权账目登记与两 audit 复验

父亲读 kernel 与 dependency facts 后，明确授权原树只完成本片账目。ledger 提交
`9d167d7ba64ca9db25f20ab654550e3155e88af4`（tree
`43b3ab1f08ed170767117817a398b115cc49725d`）：按上表真实 file/module/symbols
追加3条 capabilityToKernel/value，issue=YUK-1571，store symbols 严格为 `['*']`；
owns 说明完整共享有效诊断读取与 writer/事务锁职责保留。实际 UTC 日期为
`2026-10-20`（本地日期21日），未沿用猜测日期。

`heavy.sh pnpm audit:capability-boundaries --tighten --base 20222f2cafe1500a9e445b43fe132935405d825a`
原生 rc0，包含原生 baseline 格式化；仅收紧 agency→practice5→4 与 cross37→36，
自动追加一条 decrease 历史。changes18→19、edgeRecords20→23，两个旧历史前缀
逐项相同；compatShims7条、sourceSizeRecords1条、notes及其余字段全部相同。
server403/deep0、SCC1×3及超1500行文件13保持，未新增豁免。

在受检 ledger head 9d167 上，经 heavy.sh 单 lane 串行复验：
`pnpm audit:capability-boundaries --base 20222f2cafe1500a9e445b43fe132935405d825a` rc0；
`pnpm audit:architecture-deepening --base 20222f2cafe1500a9e445b43fe132935405d825a` rc0。
本轮相对8678只改 baseline 和本交付文档，source/catalog/audit/schema 全部保持；
typecheck/lint/build 按授权不重复，保留此前 d4bb 的真实结果，不称其验证新账目。

本轮 tighten raw/argv/UTC/rc、baseline前后件及历史前缀证明位于正确目录
`architecture-deepening/YUK-1571/8678a20c2bedd946c9da5de78188b1b935fd851e/diagnostic-read-ledger-prep/`；
两 audit 位于 `architecture-deepening/YUK-1571/9d167d7ba64ca9db25f20ab654550e3155e88af4/diagnostic-read-ledger-audits-v1/`，
`SHA256.json` 摘要 `28baa8d90c3db06ad527b3eb65f683378a8c9463ec58ba9ff95965588581f31d`。
旧失败 seal 保留；本节仅文档后提交，外部终态 seal 绑定受检账目与源码 blob。
writer clean 后停止，唯一独立 R1、PR、exact-head CI 由父统一，未自行审查。

## 已审片整合最新 main（2026-10-20 23:00 UTC）

fetch 实际 main 为 `67506c5eaa5604ba34d2c943132343bf2e7fab5e`，与父预期相同；
普通 merge 提交 `188f09856f9f365a18e71799b15eb42b4810adcb`，tree
`2186cb93b7eac307f06c727060decb232bbfc462`。无 rebase/force。
仅 baseline 追加历史一处冲突：逐 hunk 保留 main 四条 JSON decrease，保留本片
原3条精确 edgeRecords（含 store `['*']`），原生 heavy tighten rc0 重建本片
agency→practice5→4/cross37→36；保留 main server394，不回写旧403。
main changes22条全部为前缀，新增本片一条为23；main edgeRecords20条全部为前缀，
追加原3条为23；compat7/size1/notes/其他字段全部保留，无新增豁免。

五源码与 catalog 六个 blob 逐项等于已审 ca0；三 reader 正文 SHA256 相同，完整
practice blob 身份同时覆盖 loadCommitted/写协议/锁/claim/恢复正文。
4455个 main 非本片文件及 JSON 迁移14个变更路径（含删除旧路径）均与 main 相同。
唯一 R1 固定 base20222/headca0 的 APPROVE 原件 SHA256 为
`0d44c09487c1102f12ab3ad0841303b5a4012f83bf410ed0a1180609cce128a9`；
此处证明已审本片源码等价，不声称原 R1 审过新 main，不重开审查。

依赖三 hash 与父 install receipt 一致，未 install。在 exact188f 上，heavy.sh
全机2槽、本 lane 串行 typecheck/lint/build/两 audit 全部 rc0；lint180warnings，
两个 audit 显式 `--base 67506c5eaa5604ba34d2c943132343bf2e7fab5e`。
实测394/0/36、SCC1×3、超1500行13、新 pass-through0；无源码机械修补或语义 finding。
tests/DB/runtime/provider 全部 NOT_RUN，未 push/PR/自派审。

raw stdout/stderr、argv/UTC/rc、逐 owned blob/body proof 与全部 main 前缀证明封存在
`architecture-deepening/YUK-1571/188f09856f9f365a18e71799b15eb42b4810adcb/diagnostic-read-main67506-five-gates-v1/`；
manifest SHA256 `b187d1a989097719c59c0258c7a6e433ba1e9e3d0ecec500ac94e5b7e2461ad1`。
原 merge rc1/conflict hunk、tighten raw 和账目并集证明保留在 ca0 目录的
`diagnostic-read-main67506-integration/`；manifest SHA256
`e6b084510ce6637a86510171ac696a339b3d3ccbb2722d74f8d9e601d08980c2`。
本节随后仅文档提交；终态 seal 绑定到受检188f源码/账目，不冒称最终doc提交重跑五门。
