# 架构深化：目标、职责与交付证据

## 当前目标（Owner 最新 24 小时指令；依赖方向待确认）

> 你要自己把任务找出来，全力并行，而非等待任务被推上来。24小时，server到capability小于200，不牺牲优雅。

按该指令的 24 小时期限主动寻找任务、并行推进到小于 200；不以本次文档提交重置期限。数字与期限覆盖 2026-10-21「取消定总数/期限」的旧口径，旧 `≤300` 里程碑不恢复。优雅、并行开发少返工、接口易用易理解、新功能开发与旧功能维护的局部性仍是交付约束，不能为数字牺牲。

**方向尚未获 Owner 确认**：原话为「server到capability」，父线已异步询问歧义。目前暂按父线现有实测的 capability→server=384 准备降至 `<200`；反向 serverToCapabilityDeep=0，不能拿反向的零宣称目标已达成。本次只引用既有实测，不冒称新测或 Owner 已确认 capability→server 方向。

父线主动发现并收敛完整职责与真实 consumer 的任务，按独立写入权并行推进，不等待任务被推上来。此前四条独立 lane 是只读准备，不是四个实施 writer；准备结果仍须明确完整 owner、调用方收益、共享契约与精确写入边界后才能实施。

### 历史目标口径（2026-10-21；取消数字与期限的部分已过期）

> capability→server不以300为目标，而是让模块耦合降低到即便大量并行开发依旧不返工，接口易用易理解，新功能开发，老功能维护不痛苦。

上引质性目标保留；当时取消固定总数与期限、数量仅作诊断的口径，已由顶部 24 小时与 `<200` 新要求覆盖。原 `≤300` 阶段里程碑及其差额仍仅作历史，也不机械换成以 `0` 条为终点。当前同时报告同口径数字进展与真实开发、维护成果；依赖数量、SCC、文件行数不能单独证明解耦。下文带日期的历史目标、测量与裁定保留，与顶部最新目标冲突的表述不再生效。

### 执行约束与验收

后续选片与验收沿现有计划和真实变更证据回答三件事，不新建打分框架：

1. **相对独立的真实需求**：一对需求能否分别在各自 owner 内推进；明确仍须协调的共享契约、schema、状态与写入权，记录集成是否因边界设计产生返工。
2. **调用方负担**：caller 是否只需理解稳定业务操作、输入输出与失败结果；具体指出已收进 owner 的内部形态、调用顺序和恢复步骤，以及仍暴露的知识。
3. **新功能与旧功能维护**：各用一个真实场景，对照修改面、必须理解的知识和跨 owner 联动是否减少；没有实际场景或记录时明确缺口，不虚构并行成效。

源码推演与实际并行交付记录分开；没有实绩不宣称已能大量并行，也不承诺任意需求永远零返工。进度同时报告数字与期限、已解除的实际开发瓶颈、仍互相等待的任务和接口及维护负担。纯迁址仅记实际归属收益；不得靠 shell、转发壳、巨型 runtime 或改变统计口径实现数字。

本次只同步目标与任务发现、排序，不授权删除或修改既有审计/防回退门、baseline、测试、付费或锁协议。已批准逐站点公开契约分类继续有效；原 R1 初审 + 至多一次 P0/P1 修复验证 R2 预算、exact-head CI Gate、取消 17 分钟等待窗均保持。推进子 lane≤8（不含父），每树唯一 writer；重活全机≤2、本线≤1，统一 heavy.sh。测试治理仅 B3 及各自另获精确批准的改动；PARKED 的 LIGHT13 准入读职责、aada973 知识候选读取及 B 保持原边界，不据新目标扩大 assessment/model 准入域，B 只研究不迁 owner。已完成的 #1939、#1948 不重审、不重新验收；后续片按上述真实开发瓶颈与数字期限共同排序。

## 历史起点与首三片（2026-10-19）

Owner 2026-10-19 授权独立架构线与功能并行。冻结起点 `d41f24213`；数字是同口径目标，合并时重测 main 与 PR，区分本片 delta 和其他线变动。

1. **练习流职责拆分（YUK-1572）**：从 `practice/server/stream-store.ts` 提取候选输入收集、读取投影两个完整职责；现有编排入口兼容，元数据匹配细节留在投影模块内部。目标：2120 行降至 <1500，全库 >1500 文件 18→17；SCC 1 个/5 成员、capability→server 443、基线文件 141 行保持。不动 `practice/public.ts`、出题/判分/付费链、测试或 UI。
2. **学习前沿的完整决策归属（YUK-1571，Sidekick 复核后的首选）**：将先修闭包、掌握门、overflow/sparse/dense 判别及告警整体归 knowledge；练习容量与选题仍归 practice。实施前确认两个 public 端口及相关文件写入权、旧测试入口兼容、#1830 baseline writer 释放。预计知识两个消费者退出 practice 依赖；精确净边数待所有消费者闭包冻结，不提前承诺 SCC 成员下降。
3. **按前片所得再选，不默认拆 intervention.ts**：优先比较 A「练习流使用 typed due query，显式保留既有失败降级」与共享笔记投影的实际维护收益；跨域 merge operation 先完成事务/锁/恢复设计和协调裁定，不抢先搬事务。仅因 intervention.ts=2240 行不足以令其优先。

后续按当前目标处理真实耦合：错置领域业务归能力 owner、共享事实读归共享读模块、通用 model/queue/blob 的机制与产品策略分开，server 聚焦接入与组合。具体去向须以真实消费者、新功能/维护场景、资源生命周期和写入权论证；允许调用 runtime 不要求实现驻 src/server，也不允许用 kernel 转发或不计数目录宣布完成。SCC、依赖边与超长文件用于寻找跨 owner 联动和审读负担；顶部数字与期限要求同时有效，数值下降不能单独证明架构完成。继续收窄 practice 公共端口、保留锁排序及失败恢复证明义务；UI 文件仍由 UI 唯一 writer 负责。静态调用链与未运行并发验收分开。

**所有权与门禁**：六票 T3 接管；#1830 ratchet 由 Grok 完成。2026-10-20 协调线解除 baseline 独占，允许 #1837/#1852 按 main 现有规则登记实测数字；本线不改 audit 脚本或 CI 语义。上调须同 PR 抵消，净上涨例外在文件记录协调裁定；CI 语义改变先找协调线。每片分支/工作树独占，独立初审及至多一次 P0/P1 验证审，typecheck/lint/build、exact-head CI Gate 及已出现P0/P1全部裁决后 match-head merge。Owner于2026-10-21取消为等Codex审查设置的17分钟等待窗，不再建窗计时；下方已完成片的等待记录仅保留为历史事实。无本机完整测试、TEST/Docker/DB 写或产品 provider 调用。未运行的行为验收如实标 NOT_RUN。

**测试缩减文本方案（YUK-1580，未批准实施）**：先对最大 15 个测试文件和 mock 密集文件列出 case→真实边界→五类承重不变量→重复覆盖证据，逐 case 给保留/合并/删除理由与预计行数；先发协调线转 owner，得到明确批准后才动指定 case。第一批不设任意删行配额，不迁移测试以绕过批准。

**证据迁出方案（YUK-1579，协调线已批准）**：新批量日志/JSON/截图放 `/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/<issue>/<head>/`，仓库只保留简短结论、命令、精确 revision、artifact 路径与 SHA-256。既有证据先建引用清单，复制到外部、逐文件核 hash、验证备份/访问与历史引用兼容后，再逐批提出删除清单；不直接清理 git 历史，不删除唯一副本。协调线确认存储与保留策略前不批量迁删。

## 首片验证检查点

源码 `2cd19533a`，正常合入 main `615437b76` 后验证提交 `d38e72c44710523104a9659965afb15c4fa19a74`：stream-store 2120→1427，输入模块355、投影410；超长18→17，SCC 1/5成员、capability→server443、cross-value48、baseline141行不变。父级 `pnpm typecheck`、`pnpm lint`（179 warnings）、`pnpm build`、`pnpm audit:capability-boundaries`、`pnpm audit:architecture-deepening` 均 exit 0。测试代码零改动；本机测试、DB、运行时、TEST、provider 均 NOT_RUN；独立初审与 exact-head CI 待收齐。

原始日志和指标：`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1572/d38e72c44710523104a9659965afb15c4fa19a74/`；逐文件 SHA-256 见 `checks-sha256.json`，该索引 SHA-256 `73b7de1807a5076ae427377af020477219ec1b97784db2dffe19894f99a30ec8`。此前 `2cd19533a` 的父级检查被中断，不复用缺失退出状态。

## Sidekick 首轮落实与下一片前后对照（2026-10-19）

首片按**局部深化＋职责整理**交付：view 隐藏 metadata 匹配和两处调用方的中间 map；inputs 主要是既有 collectComposerInputs 的职责迁移，原导出仍在，filter→view 与 recoveryRowIds/预算关系仍横跨模块。2120→1427、超长-1只是辅助结果，不代表整体解耦。

五项标准落点：①每片先列事实与完整操作owner，不让入口重写语义；②至少两个真实变化场景比较需理解/修改的位置；③明确哪些中间态/顺序知识退出调用方，已有封装不冒充新深化；④保留事务、锁序、幂等/失败/恢复owner及证据分层；⑤按维护痛点、风险、写入权调整顺序，数字不替代语义判断。

**首选 frontier，原因与限度**：knowledge 的页面与夜间 bootstrap 目前要依赖 practice 才能解释自己的先修图。拟使 knowledge 拥有“读图→有界闭包→canonical mastery→判别结果”完整只读决策；practice 仅消费可练知识点并施加本身的5题容量。闭包 SQL、掌握门0.7+evidence≥4、冷启动默认、稳定排序、整结果overflow拒绝和单点warn保持原样；这不是检索向量/打标阈值合并。

- 调用方知识前→后：knowledge 两消费者不再知道 practice 公共facade或练习配额；practice 不拥有/解释闭包和掌握公式，只保留既有id消费策略。该算法原本已有封装，所以本片主要收益是正确归属与变化局部性，不能声称从零隐藏了所有复杂度。
- 真实变化一：改变先修闭包的溢出诊断字段。原需跨 practice算法/public、knowledge rail与nightly 理解判别；之后算法与解释都在knowledge内部，practice若仍消费ids无需修改。真正改行为时仍单独批准，不在本片调参数。
- 真实变化二：改变每日练习前沿配额/选题排序。原 FRONTIER_MAX_ITEMS 与knowledge闭包契约同文件；之后配额/选题完全留practice，knowledge算法与两个消费者不变。反向，knowledge提出边的bootstrap门不能影响练习配额。
- 真正退出：practice不再保存闭包/掌握门实现；knowledge两个生产入口退出practice/public。现有测试若仍需旧导出，则明确标为兼容残留，不能把alias当新深模块或宣称旧路径全退役；未获owner批准不修改测试。
- 状态/失败：只读Db/Tx不增加事务、锁或持久状态；三态不能折叠。nightly对overflow跳过；dense且ids≤floor仍bootstrap；pre-model查询失败继续抛出，不能加吞错。现有manifest贡献路径不变。原query/事务可观察时序与日志逐处对照。
- 证据：固定base/head源码对照、既有类型/构建/审计和exact-head CI；本机DB/真实图闭包/模型运行NOT_RUN。真实并发、部署、学习效果不得从CI推导。尚缺：最终消费闭包、兼容导出是否阻碍真正退役、功能线writer释放和净边数实测。

**候选A暂排其后**：stream-inputs.ts:123–128构造内部Request、调handleReviewDue再读JSON，已有queryReviewDue可复用。固定limit=200；query本身做1..200 clamp，handler的parseInt对这个固定值不产生差异。但handler catch→errorResponse→没有rows时回退[]，一般错误还会写unhandled error日志，ApiError不写该日志；直接改await query会把原降级改成抛错，不能机械替换。若选A，必须明确练习输入收集拥有降级策略、HTTP handler保留协议整形，并核对序列化失败与后续intervention查询仍抛错的边界；不新增只转发的port。

**跨域merge暂做设计，不改owner**：2026-09-06-business-ownership-and-tests.md:23–25明确Knowledge拥有原子merge事务和receipt；要上移agency须协调裁定。设计须先覆盖proposal锁→全局学习态锁→排序node锁→九面修复顺序→receipt/project同事务，以及sweep/backfill重入、幂等与恢复，不能先搬代码后补证明。

### Frontier 首片实施边界（主线已释放写入权）

分支 `refactor/yuk-1571-frontier-ownership`，从main `22b03fd5` 开始。优先把完整闭包决策并入既有 `knowledge/server/frontier-read.ts`（当前309行，已拥有canonical mastery读取），让graph决策与rail解释同owner；不是为减边新造wrapper。`knowledge/jobs/frontier_fill_nightly.ts`改读本域；`knowledge/public.ts`暴露必要决策端口；practice `learnable-frontier.ts`只保留练习侧5题配额、既有id适配及旧导出兼容，不改practice/public.ts和测试。跨capability目录更新为真实消费者，不改CI语义。预计knowledge→practice少2文件边、practice→knowledge加1，cross-value48→47；practice→mastery少1且knowledge复用现有import，cap-server444→443；SCC仍1/5成员、超长18不变。全部为待实测目标。

`audit-capability-boundaries.ts`及baseline在#1830合入前保持原样；源码可先完成，旧基线因真实下降报错须记为待收紧，不能冒充PASS或绕过门禁。Grok释放后用其已合机制收紧，不另写ratchet。

首片#1834已于13:25:34 UTC合入main22b03fd5：R1 APPROVE，exact2a7d006 CI39257589648全绿，17分钟窗满足。相对新main超长19→18、SCC1→1、server444→444、baseline142→142；主线增加的source_verify1723行与R2边单独归因。

### Frontier 源码检查点（待 baseline writer 释放）

源码 `5fc5bdfec`：graph决策实际位于knowledge/frontier-read（634行），practice/learnable-frontier保留5题容量、ids适配及原public兼容（28行）；knowledge公开仅结果类型、判据和完整resolver。旧practice算法实现退出，兼容入口保留；不把兼容alias称作新深模块。两个已知变更场景与上述计划一致。

父发现子交付曾把旧audit的SQL marker留在shim注释使反查通过，已删除该做法并将relations登记改指新真实SQL；mastery字段读取本来已由frontier-read登记覆盖，删旧无读取项。两审计逻辑/准入语义均未改，不能用伪marker当覆盖。

父级typecheck、lint（179 warnings）、完整build、relations均exit0；mastery-provenance report-only exit0且无flagged，不冒称硬门。snapshot为server443（原444）、cross47（原48），SCC仍1/5成员。architecture audit exit1，五项全部为旧baseline差异，含practice→knowledge3→4；新增边语义为practice消费knowledge真实图决策，同时knowledge两个入口退出practice，数量抵消不替代语义论证。#1830尚未合，本线未写audit-capability/baseline，仍不能开合并绿灯。独立初审进行中；本机测试/DB/运行时/provider NOT_RUN，测试零修改。

证据目录：`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1571/5fc5bdfec4b536f048fb5d78d9f5995210720d2c/`；逐文件哈希见checks-sha256.json，索引SHA-256 `c1f3570cc7cdbb15f603093be91d876770a2f46d27ad213fad8b38c7ed771d7e`。本片未新增范围外可执行缺陷；修正仅限自身未发布交付，既有report-only治理信号不另开重复票。

### Frontier 初审及回边纠正

R1 Kimi K3在22b03fd5..5fc5bdfec给APPROVE、无P0/P1，但明确新增文件级环knowledge/public→frontier-read→mastery/state→knowledge/public无初始化风险。父不把初始化安全当作架构成功：0c5837e33让mastery/state直接读取现有kernel/read-models/knowledge-tree的同两函数（knowledge/public原本逐字re-export它们），删除该直接回边。此post-review import-only差异由父核对，不冒称R1覆盖，也未重开全量审查。

0c5837e33父typecheck/lint179warnings/fullbuild均exit0，snapshot443/0/47、SCC1/5、超长18；baseline仍142行未改。R1及旧审计日志在5fc5bdfec目录，最新日志在 `/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1571/0c5837e330dc76c1f21d47748c2bf0820f87c0a9/`，checks-sha256.json索引SHA256 `12c28d58a809059a568b13030aa36b2ec4fc0959b20f65687f223d6fb1788716`。待#1830释放后整合收紧与exact-head CI，当前仅可draft，不能merge。

### 基线写权释放与登记（2026-10-20）

协调线已明确解除 #1830 对 baseline 的独占：两个架构 PR 可先登记，谁先 exact 绿先合；Grok 后续普通 merge main 并适配已登记数字。此裁定取代前文历史检查点的等待条件，不授权改审计或测试。

#1837 在 main `1440e864b` 上实测：practice→mastery15→14、capability→server441→440；knowledge→practice3→1、practice→knowledge3→4、cross48→47；SCC仍1个5成员，>1500源文件17不变。新增practice→knowledge是消费knowledge完整frontier决策的真实依赖，knowledge/frontier-read和nightly两个旧practice读取退出，在同PR同类别抵消新增1条；不能仅以净减解释。退出条件是在YUK-1571拆环时一并处理残留依赖。上述三点已记入baseline note，数值由现有CLI重新生成核对；不创建新门禁。
