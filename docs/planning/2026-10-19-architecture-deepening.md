# 架构深化：首三片与验收

Owner 2026-10-19 授权独立架构线与功能并行。冻结起点 `d41f24213`；数字是同口径目标，合并时重测 main 与 PR，区分本片 delta 和其他线变动。

1. **练习流职责拆分（YUK-1572）**：从 `practice/server/stream-store.ts` 提取候选输入收集、读取投影两个完整职责；现有编排入口兼容，元数据匹配细节留在投影模块内部。目标：2120 行降至 <1500，全库 >1500 文件 18→17；SCC 1 个/5 成员、capability→server 443、基线文件 141 行保持。不动 `practice/public.ts`、出题/判分/付费链、测试或 UI。
2. **拆除首组反向 capability 依赖（YUK-1571）**：按调用链定位 knowledge/notes 与 practice 的领域归属错误，迁移完整 owner operation 或收窄现有领域端口；拒绝转发包装与把循环藏到 kernel。目标 cross-capability value 48→≤47，SCC 成员减少或至少移除一条组成环的有向依赖；capability→server ≤443，超长文件 ≤17。具体路径和精确 delta 在首片源码调查后冻结，再与功能线核对。
3. **再拆一个独立超长领域模块（YUK-1572）**：优先 `core/schema/intervention.ts` 的干预契约职责拆分，按实际消费者划分而非平均分行；不触及测试。目标 2240→每文件 <1500，超长文件 17→16；SCC 与 capability→server 不增加。若第二片暴露可一次消环的完整小切片，优先替换为消环片并向协调线报修订。

后续顺序：持续拆环至 SCC=0 → capability-owned 模块消除 server 依赖至 ≤300、收窄 practice 公共端口 → 其余超长文件 → 锁登记及获取顺序证明 → 审计合并。UI 文件由 Opus UI 唯一 writer 负责。锁证明须区分静态调用链与未运行的并发验收。

**所有权与门禁**：六票 T3 接管；#1830 ratchet 由 Grok 完成，本线合入前不写审计或 baseline。上调须同 PR 抵消，净上涨例外在文件记录协调裁定；CI 语义改变先找协调线。每片分支/工作树独占，独立初审及至多一次 P0/P1 验证审，typecheck/lint/build、exact-head CI Gate 和等待窗后 match-head merge。无本机完整测试、TEST/Docker/DB 写或产品 provider 调用。未运行的行为验收如实标 NOT_RUN。

**测试缩减文本方案（YUK-1580，未批准实施）**：先对最大 15 个测试文件和 mock 密集文件列出 case→真实边界→五类承重不变量→重复覆盖证据，逐 case 给保留/合并/删除理由与预计行数；先发协调线转 owner，得到明确批准后才动指定 case。第一批不设任意删行配额，不迁移测试以绕过批准。

**证据迁出方案（YUK-1579，协调线已批准）**：新批量日志/JSON/截图放 `/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/<issue>/<head>/`，仓库只保留简短结论、命令、精确 revision、artifact 路径与 SHA-256。既有证据先建引用清单，复制到外部、逐文件核 hash、验证备份/访问与历史引用兼容后，再逐批提出删除清单；不直接清理 git 历史，不删除唯一副本。协调线确认存储与保留策略前不批量迁删。

## 首片验证检查点

源码 `2cd19533a`，正常合入 main `615437b76` 后验证提交 `d38e72c44710523104a9659965afb15c4fa19a74`：stream-store 2120→1427，输入模块355、投影410；超长18→17，SCC 1/5成员、capability→server443、cross-value48、baseline141行不变。父级 `pnpm typecheck`、`pnpm lint`（179 warnings）、`pnpm build`、`pnpm audit:capability-boundaries`、`pnpm audit:architecture-deepening` 均 exit 0。测试代码零改动；本机测试、DB、运行时、TEST、provider 均 NOT_RUN；独立初审与 exact-head CI 待收齐。

原始日志和指标：`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1572/d38e72c44710523104a9659965afb15c4fa19a74/`；逐文件 SHA-256 见 `checks-sha256.json`，该索引 SHA-256 `73b7de1807a5076ae427377af020477219ec1b97784db2dffe19894f99a30ec8`。此前 `2cd19533a` 的父级检查被中断，不复用缺失退出状态。
