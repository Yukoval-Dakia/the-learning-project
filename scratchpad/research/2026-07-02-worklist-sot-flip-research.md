# Research Dossier — 单元 #5 SoT-flip oracle（event-sourcing-fold-sot-flip-status）

三腿输入：CODE（code-ground）/ LIT（文献）/ OSS（产品源码先例），2026-07-02 synthesis。

---

## 单元与打磨目标

打磨对象：event-sourcing fold 架构里「什么样的证据才够格判定『可以把 `PROJECTION_IS_WRITER_X` 从 OFF 翻成 ON』，以及翻转之后靠什么持续证明 fold 没有偷偷漂移」——即 **SoT-flip oracle** 本身的有效性，而非 fold/reducer 业务逻辑本身。目标是判定：现有 `audit:projection` + accept-time in-tx parity assert + B3 gate，是否构成一个真正独立的 oracle，还是在 flip 之后退化成「reducer 核对自己」的 tautology；并给出可执行的补强设计输入。红线（不碰 mastery/θ̂/FSRS/difficulty，纯基础设施层）在三腿产出中均未被触碰。

---

## Code-ground（现状 + stale 标注 + 残留缺口）

### SoT flag 现状表

`src/server/projections/sot-flag.ts:57-80` 定义 6 个 flag domain，覆盖 7 个 `subject_kind`；`docker-compose.mac.yml`（owner Mac 本地生产栈，**该文件本身 git-untracked**，`git status` 显示 `?? docker-compose.mac.yml`）是当前 live 配置的唯一 SoT：

| flag | 覆盖 subject_kind | 当前值 |
|---|---|---|
| `PROJECTION_IS_WRITER`（global）| knowledge, knowledge_edge | **ON**（`docker-compose.mac.yml:16,21`）|
| `PROJECTION_IS_WRITER_ARTIFACT` | artifact | **ON**（`:17,22`，注释"flipped 2026-06-28"）|
| `PROJECTION_IS_WRITER_QUESTION_BLOCK` | question_block | **ON**（`:18,23`，注释"flipped 2026-06-28，69 rows folded clean"）|
| `PROJECTION_IS_WRITER_GOAL` | goal | 未出现于 compose → **OFF**（默认）|
| `PROJECTION_IS_WRITER_MISTAKE_VARIANT` | mistake_variant | 未出现 → **OFF** |
| `PROJECTION_IS_WRITER_LEARNING_ITEM` | learning_item | 未出现 → **OFF** |

flag 每次调用读 `process.env`（`sot-flag.ts:72-80`），prod 侧启动期固定，改动需重启三进程。

### ⚠️ 任务背景陈述本身已 stale

本单元任务下发时的编排者摘要写「knowledge_edge 已 LIVE fold-owned，goal/learning_item/artifact 等仍 row-owned 待翻」——与上表矛盾：artifact 和 question_block 已于 **2026-06-28** 翻转 ON，只有 goal / mistake_variant / learning_item 三者仍 OFF。**Register 正文本身没有这个错误**（master register line 674 明确写"3/6 entities still OFF+live-assert"，line 672 引用 `docker-compose.mac.yml`/`PLAN.md:128` 作证据）——过时的是**编排者摘要**，不是 register 文档本身。这一点对设计相有直接影响：任何以"knowledge_edge 是目前唯一已翻实体"为前提的设计推理都是错的，真实前提是**已有两个非-W1 实体带着结构性缩水的验证流程在生产跑了数天**。

### Parity 断言全貌

`src/server/projections/parity.ts`（1072 行）：
- `onParityMismatch`（`:70-90`）：`NODE_ENV==='production'` → `console.warn`（只打字段名+count，不打值）+ return；否则（dev/test）→ throw。
- 7 个 subject_kind 全部布线 `assertXParity` + genesis-anchor gate（`hasXGenesisAnchor`），每个 assert 只在该行 event-sourced 时才跑，未 backfill 的行被静默跳过（既非 pass 也非 fail，是「未知」）。
- 排除字段：knowledge 的 `embed_*`（`:99-125` 字段选择不含）、question_block 的 legacy `extracted_prompt_md`（`:1024-1028` 显式 strip）、learning_item 的 `child_learning_item_ids`/`ai_score`/`due_at`/`reviewed_at`（`:737-786` EXCLUDED 注释+实现）。
- **实测确认 register 的死代码断言**：`body-blocks-edit.ts:136-172` 的 `else` 分支（imperative UPDATE + `assertArtifactParity` 的 prod-warn 路径）在 prod 现在**不可达**——artifact flag 已 ON，永远走 `if` 分支（`projectArtifactGuarded`）。

### Fold/gather 管线完整度

`src/server/projections/gather.ts`：全 7 个 `gatherAndFoldX` 函数存在——knowledge node（Q1+Q2+Q3+rate chain）、knowledge_edge（mesh 参数化，O(E) 非 O(E²)，B3-perf PR #582 已合）、goal（Q1+proposal chain）、mistake_variant（Q1+chain）、learning_item（Q1+**Q3 无界全表扫描**+rate chain）、artifact（Q1-only）、question_block（Q1+Q2 jsonb containment）。

**新发现（register 未列）**：`gatherAndFoldLearningItem(db, itemId)`（`gather.ts:273-276`）目前**没有** `prefetchedMergeEvents` 参数——每次调用都无条件 `db.select().from(event).where(eq(event.action,'experimental:knowledge_merge'))` 拉全表。`scripts/audit-projection.ts:393-404` 对**每一个** learning_item 行循环调用这个函数，导致 O(N_items × N_merge_events) 的重复全表扫描，且没有像 edge 那边（`gatherAndFoldKnowledgeEdgeWithMesh`，mesh 一次性拉入参）已有的批量化先例。这正是 YUK-547（"Q3 prefetch threading"）要补的口子，**尚未实现**（代码库零 `prefetchedMergeEvents` 命中）。`git branch -a | grep -i "545\|546\|547"` 零命中——YUK-545/546/547 均**无 branch/worktree，纯 Linear 占位，未开工**。（YUK-544 有独立 worktree `yuk-544-sweep-auto-invoke`@`82812ba1`，**也未合并进 main**。）

### 翻转操作面 —— 两条不等价的 gate 强度

- **W1**（knowledge/knowledge_edge）用 `pnpm b3:gate`（`scripts/b3-gate.ts`，PR #583 已合）：snapshot before-id → scoped genesis backfill → **pre-rebuild audit**（fold vs 当前 imperative row）→ **单事务 rebuild**（re-fold 每行 in place）→ **对称 rowset parity**（双向 diff：rebuild 删掉的行 + rebuild 凭空复活的行）。GO iff 三者全过。
- **W3-D**（artifact/question_block）按 `docs/superpowers/plans/2026-06-27-yuk471-w3d-flip-runbook.md` §3 执行：只有 backfill + `pnpm audit:projection`（步骤 2-3），**跳过 rebuild + 对称 rowset-parity**。这不是选择，是结构性缺失：`scripts/rebuild-projection.ts` 的 `rebuildProjection()` 硬编码只处理 `knowledge`/`knowledge_edge`（grep 确认无其余 5 个实体字样）；`scripts/b3-gate.ts` 同样硬编码（`liveNodeIds`/`liveEdgeIds` 两个专属函数，`import { knowledge, knowledge_edge } from '@/db/schema'`）。**没有任何脚本把 b3-gate 的 5 步流程泛化到其余 5 个 flag domain。**

后果：b3-gate.ts 自己的文档注释承认 rebuild+对称-parity 才是"real value teeth"——能抓住 audit:projection 结构性抓不到的两类风险（①genesis backfill 范围界定错误导致某行被误判「非 event-sourced」而在 rebuild 中被删；②rebuild 凭空复活、live 无对应行的幽灵行）。**这两类风险从未在 artifact / question_block 身上被检验过**——它们是目前唯一两个"已经翻了"的非-W1 实体，却是唯一没走过完整 b3-gate 的实体，且已经在生产运行数天（2026-06-28 → 2026-07-02）。若 goal/mistake_variant/learning_item 沿用 W3-D 先例而非重新泛化 b3-gate，会重复而非收窄这个缺口。

### Register 诉求逐条 fresh/stale 判

1. **"git-track/manifest the live flag state"**（#4）—— **FRESH，未落地**。`docker-compose.mac.yml` 目前仍 untracked。最便宜、最直接的一环，尚未执行。
2. **"add the missing prod-warn-branch test, OFF-entity coverage"** —— **FRESH，未落地**。`parity.db.test.ts`（唯一含 `NODE_ENV` 的测试文件）文件头自述"跑在 `NODE_ENV !== 'production'`"，只覆盖 knowledge node/edge 且从不测 prod-warn 分支本身；`parity.unit.test.ts` 只测 `<fold-threw>` 路由。goal/mistake_variant/learning_item（当前**唯一真实可达**的 prod-warn 分支）零测试覆盖。
3. **"drop 'cron the audit' as ON-entity fix"**（否定性诉求）—— 现状与建议一致："确实没做"：`pnpm audit:projection` 不在 `pnpm test` 链（`package.json:20` 只挂 `audit:profile`+`audit:draft-status`），`.github` 与 scripts 全仓搜索零 cron/schedule 痕迹。**（本轮 CODE lane 独立复核确认：全仓无 CI/cron wiring）**
4. **"独立 oracle for post-flip ON entities"（reducer-hash 触发重扫 / shadow-write compare）**—— **FRESH，未落地，是最大的开放缺口**。代码库零实现：无 reducer 代码哈希机制、无留存 prod-clone 策略、无 shadow-write compare harness。
5. **Priority=P1，理由"诊断的 backstop 对 4 个 ON 实体根本不存在"**—— **仍成立**，独立复核：`audit:projection` 对 ON 实体而言，用同一套 `gather.ts` reducer 重新 fold 再比对——本质是「reducer 对自己一致」的 tautological check，抓不到 reducer bug 本身，只能抓 out-of-band 直改行的情况。

### 残留缺口清单（"今天翻 flag，哪些证据有 / 没有"）

**有的**：pre-flip `audit:projection` clean 快照（每次翻转前跑过）；7 subject_kind 全部布线 accept-time parity assert（对 event-sourced 行即时生效）；W1 专属完整 b3-gate 5 步（仅对 knowledge/knowledge_edge 有效）；空 allowlist（`scripts/audit-projection-allowlist.json` 只有 `_comment`，0 条已知例外）。

**没有的**：
1. git-tracked 的 flag 状态清单——生产实际配置只活在 owner 本机文件系统，无 PR 审查轨迹。
2. artifact/question_block 翻转时的 rebuild+对称 rowset-parity 验证——从未跑过，两个 ON 实体存在未经检验的"genesis backfill 范围误判"/"幽灵行复活"敞口，已生产运行数天。
3. goal/mistake_variant/learning_item 若沿用 W3-D 先例，会重复而非收窄缺口2（`rebuild-projection.ts` 同样不支持它们）。
4. ON 实体的持续性 reducer-bug 探测机制——register 点名的核心 P1 杠杆，代码 0 行落地。
5. prod-warn 分支测试覆盖——0 测试验证 `NODE_ENV=production` 时真的走 warn-not-throw；goal/mistake_variant/learning_item 零覆盖。
6. learning_item 的 Q3 无界扫描在 `audit:projection` 场景下重复全表扫描（YUK-547 未实现）——非正确性阻塞项（reducer 本身 chain-safe），但拖慢 oracle 工具在有意义数据量级下的可操作性。
7. 一次真实生产回滚的实测记录——回滚路径只有文档承诺（`docker-compose.mac.yml` 注释），从未实测验证。
8. 翻转顺序依赖无运行时护栏——runbook §2 写"learning_item flip after artifact"（W3 retract path 耦合），但 `sot-flag.ts` 无任何机制强制该顺序，纯靠人读文档；runbook §4 明确警告"不要一次翻全部"同样无代码护栏。

### 改动面预估（未做拟合/估计，纯结构性判断）

- **缺口1（git-track manifest）**：极小，1 个 PR，零逻辑改动。
- **缺口2+3（通用化 b3-gate）**：中大——把 `rebuild-projection.ts`/`b3-gate.ts` 按 `ProjectionEntity`（`sot-flag.ts` 已有 6 元素 union type，可直接复用）参数化；复用 `gather.ts` 现成 7 个 `gatherAndFoldX` 函数，无需碰 reducer 本身。1 个中型 PR。
- **缺口4（持续性探测）**：中——CI-hook（reducer 文件 diff 触发重跑 b3-gate class 验证）或 shadow-write compare 二选一，纯运维/CI 加固，不动 reducer。1 个中型 PR。
- **缺口5（prod-warn 测试）**：小——3 个新 `it()`（每 OFF 实体一个），mock `NODE_ENV='production'`。半天量级。
- **缺口6（YUK-547）**：小——`gatherAndFoldLearningItem(db, itemId, prefetchedMergeEvents?)` + `audit-projection.ts` 循环外一次性拉取传入；改动局限 1 个函数 + 1-2 个调用点。
- **缺口7（回滚演练）**：非代码改动，是一次操作演练（建议先在风险最低的 question_block 上做）。
- **缺口8（顺序护栏）**：小，运行时 assert，把文档承诺转成 code-level guard。

1/5/6/7/8 都极小或零代码；2/3/4 是本轮 oracle 建设主体工作量，均可复用现有 `gather.ts`/`sot-flag.ts` 抽象，不涉及任何 reducer/事件 schema 改动——符合红线（不碰 mastery/θ̂/FSRS/difficulty，纯基础设施层）。

**关键证据文件**：`src/server/projections/sot-flag.ts`、`src/server/projections/parity.ts`、`src/server/projections/gather.ts`、`scripts/b3-gate.ts`、`scripts/rebuild-projection.ts`、`scripts/audit-projection.ts`、`docker-compose.mac.yml`、`docs/superpowers/plans/2026-06-27-yuk471-w3d-flip-runbook.md`、`PLAN.md:128`。

---

## 文献（带权威分级）

前置 code-ground 结论（LIT lane 独立复核，与 CODE lane 一致）：**flip 前**（OFF）oracle = `gatherAndFold*`（fold）vs 独立写的 imperative row，两条腿是分离的（有效 oracle）；**flip 后**（ON）该实体的 row 本身由 `gatherAndFold*` 写入，此时 `audit:projection` 再拿同一 reducer 去核对同一 reducer 刚写的 row，是**同一份代码在核对自己**——这正是下面调研锁定的经典反模式（pseudo-oracle 违例）。

### 方向① 差分测试 / oracle 构造（"同一 reducer 核对自己"为什么不成立）

**1. Davis & Weyuker, "Pseudo-oracles for non-testable programs" (ACM '81 Conference, 1981)**
- 要点：提出 pseudo-oracle 概念——无法获得规范意义上的 oracle 时，用一个**独立撰写**（separately written）的参照程序对同一输入产生输出、再比较；核心前提是"独立撰写"，隐含排除"用被测系统自身的同一段逻辑核对自身"这种退化情形（比较必然恒等，不携带信息）。
- 权威分级：ACM 会议论文（1981），非现代 CCF/CORE 分级体系覆盖范围内的老论文，但被后续 IEEE TSE 综述反复引用为奠基性定义来源，公认经典。
- 真实性核验：Semantic Scholar + dblp 双重核验作者/年份/主题一致；未能直接读取全文（仅摘要级信息），标记为**二手转述**。
- 适用性/局限：直接解释了"flip 后 audit:projection 用同一 reducer 核对同一 reducer 写的 row"结构性地不是一个 oracle——违反 pseudo-oracle 的"独立撰写"前提。局限：不提供"多接近算独立"的量化标准，只给定性判据。

**2. Barr, Harman, McMinn, Shahbaz, Yoo, "The Oracle Problem in Software Testing: A Survey" (IEEE TSE, 2015)**
- 要点：系统性分类 oracle 自动化技术——specified oracle、derived oracle（含 pseudo-oracle / N-version 比较）、implicit oracle、metamorphic testing、differential testing；强调 oracle 与 SUT 的关系质量（独立性/信息增量）是判断 oracle 是否有效的核心维度。
- 权威分级：IEEE TSE 顶级期刊（CCF-A），scispace 显示引用量约 1063（**第三方聚合站点自报，未逐一核对，标记为近似值**）。
- 真实性核验：dblp + ACM DL + KAIST 机构页三方交叉确认作者、卷期（41(5):507-525）、DOI (10.1109/TSE.2014.2372785)。
- 适用性/局限：最权威的分类框架来源，可直接用其术语（pseudo-oracle / derived oracle）命名"audit:projection 目前属于哪一类、为什么无效"。局限：不特化于事件溯源/CQRS 场景。

**3. McKeeman, "Differential Testing for Software" (Digital Technical Journal, Vol.10 No.1, 1998)**
- 要点：差分测试原始命名论文——同一输入喂给多个"可比但非同源"的实现，输出不一致即报告潜在 bug；不要求知道"正确答案"，只要求实现**彼此独立**。
- 权威分级：DEC 公司技术期刊，**非传统同行评审学术期刊**（工业技术出版物），但被广泛视为该子领域奠基文献；引用量约 564（同为第三方自报，未逐一核对）。
- 真实性核验：dblp 条目核验标题/年份/卷期一致。
- 适用性/局限：给出"差分测试"名词历史锚点，强化"比较双方必须非同源"这一硬约束——与 Davis & Weyuker 互相印证。局限：面向编译器/运行时场景。

**4. Chen & Avizienis, "N-version programming" (FTCS-8, IEEE, 1978)**
- 要点：N-version programming 要求 N 个版本由不同团队独立解释同一份规格、独立设计实现，投票/比较容忍设计错误；但后续实证工作发现独立开发版本**仍常出现相关联失效模式**（对规格的共同误解会绕过独立性假设）。
- 权威分级：FTCS 是可靠性计算领域重要 IEEE 会议，该文是领域奠基论文之一。
- 真实性核验：ResearchGate + IJCA + Springer 多来源交叉确认；具体引用数未逐一核验，仅确认"广泛公认为奠基文献"。
- 适用性/局限：**关键警示**——即便把 audit:projection 换成"第二份独立写的核对逻辑"，如果仍是对同一份规格的另一种解读，仍可能与主 reducer 共享同一处误解（common-mode failure），不能天真认为"写两遍就独立"。应写进设计 doc 的风险提示。

**5. Jiang, Wang, Zhang, Yap, Liang, Rigger, "Enhanced Differential Testing in Emerging Database Systems" (arXiv:2501.01236, 2025)**
- 要点：新兴数据库系统无法直接双向比较时，把新系统行为**映射回一个已被信任的独立参照实现**作为 oracle；工具 SQLxDiff 发现 57 个此前未知 bug。
- 权威分级：**PREPRINT（arXiv-only，未见会议/期刊二次发表记录，标记为 UNVERIFIED 同行评审状态）**，降权处理。
- 真实性核验：arXiv 摘要页直接核验标题/作者/摘要一致。
- 适用性/局限：给出可操作的"绕过同源问题"范式——offline B3 audit 若要独立，至少不能复用 `gatherAndFold*` 这条热路径函数本身，哪怕改成"结构上不同的第二次计算"（如基于原始事件字段的 checksum/hash 比对）。

**6. GitHub Scientist（`github/scientist`，工程实践 + GitHub 官方工程博客）**
- 要点：production 重构验证工业标准模式——control（旧路径）与 candidate（新路径）并行执行、比较结果，只返回 control 结果（新路径 bug 永不影响用户）；候选与对照必须是两条真正独立执行的代码路径。
- 权威分级：**非同行评审，工业 OSS + 官方工程博客（gray literature）**，采用极广，是业界事实标准。
- 真实性核验：GitHub 官方仓库 + GitHub Blog 一手信息源核验。
- 适用性/局限：本仓库现有 `assertLearningItemParity` 等 accept-time in-tx 断言，结构上就是一次 Scientist 实验（control=imperative write，candidate=fold）——**只要 imperative 路径还在写，这个 oracle 就有效**。核心指引：flip 到 ON 之后若彻底停写 imperative 路径，就等于把 control 也删除了，比较对象凭空消失，"tautological"正是这一后果的准确描述。

### 方向② 在线数据迁移安全模式（expand-contract / parallel-run / dark reads，含量化阈值）

**1. Fowler, "Parallel Change" (martinfowler.com bliki, 2014)**
- 要点：不兼容变更拆成 expand（新旧共存）→ migrate（消费者逐步切换）→ contract（下线旧路径）三阶段。
- 权威分级：**行业 bliki，非同行评审**，Martin Fowler 权威性高，被广泛视为该模式正式命名来源。
- 真实性核验：martinfowler.com 官方一手来源。
- 适用性/局限：直接映射本仓库现状——`PROJECTION_IS_WRITER_LEARNING_ITEM` 语义上是"migrate 阶段切换开关"，B3 gate 是"migrate→准备 contract"前的验收点。局限：不讲如何验证 migrate 阶段的正确性，只讲阶段划分。

**2. Sato & Fowler / Ambler & Sadalage, *Refactoring Databases: Evolutionary Database Design* (Addison-Wesley, 2006) + ThoughtWorks 后续技术文章**
- 要点：expand-contract 具体化为加新列→dual-write→backfill→切读→删旧列；"migrate 阶段"时长由"backfill 完成 + 观察窗口内无新增分歧"两个条件联合限定。
- 权威分级：行业专著（Addison-Wesley），ThoughtWorks 一线实践沉淀，非同行评审但事实标准。
- 真实性核验：Amazon 出版信息页 + martinfowler.com 文章页交叉确认书目/作者一致。
- 适用性/局限：与本仓库场景高度同构，可借用阶段命名法，让"何时敢翻 flag"锚定在明确阶段边界而非时间点。

**3. Lu, Wang, Gu, "New Recruiter & Jobs: The Largest Enterprise Data Migration at LinkedIn" (LinkedIn Engineering Blog, 2021-07-23；配套 arXiv:2102.01244, 2021-02)**
- 要点：提出"Convergence Principles"（数据/时间/工程过程收敛），给出**可直接借鉴的量化判据**：
  - "nearline stream validation success rate"作为 online dual-write 可靠性的**领先指标**；
  - "data consistency among data not recently updated 应保持 100%"——**稳态阈值判据**（存量、非活跃数据必须零分歧，非"平均没问题"）；
  - ramp 前 3 天冻结批量操作、选周日凌晨窗口执行切换；
  - 最终目标："steady state data consistency rate well above 99.999%（most often 100%）"。
- 权威分级：**一手工程博客（LinkedIn 官方，非同行评审）**；配套 arXiv 版本经核验为**arXiv-only preprint，未见会议/期刊二次发表记录（PREPRINT，降权）**，但两者作者、内容高度一致，可互证非编造。
- 真实性核验：LinkedIn 官方 Engineering Blog 一手抓取全文核验，与 arXiv 摘要页交叉核对作者名单一致。
- 适用性/局限：**本次调研对"多长观察窗/何种失配率算 ready"给出最具体量化表述的来源**。可改写为本单元判据：① 定义 learning_item 的"leading indicator"=accept-time in-tx parity mismatch 率（当前机制已具备，只是被 prod 静默 warn 吞掉，需接出可观测指标）；② 定义"稳态判据"=对已 backfill 且近 N 天未变更的 learning_item 子集，离线重新 fold 必须 100% 零分歧（非仅看新写入路径）；③ flip 前设置类似"冻结窗口"操作纪律。局限：讨论的是**两个独立存储系统之间**的迁移（legacy RDBMS → Espresso），其"验证"天然独立于任一写路径；本仓库场景是**同一套 event 日志→两种投影方式**，独立性弱于该案例，不能直接照搬"两套存储互证"的强独立性假设。

**4. Stripe 工程团队, "Inside Stripe: Zero-Downtime Data Movement at Trillion-Dollar Scale" (QCon SF 2025 演讲 / Stripe engineering blog, 2025)**
- 要点：cutover 前"exhaustive correctness check"明确采用**双侧各自独立的 point-in-time snapshot**做比较（而非复用写路径的中间结果）；切换后仍保留**反向双写（reverse dual-write）**一段时间维持快速回滚能力；带版本号的路由协议保证切换窗口内不出现撕裂读。
- 权威分级：**行业会议演讲 + 官方工程博客（非同行评审）**，Stripe 工程权威性高、细节详实。
- 真实性核验：Stripe 官方 dev blog + QCon 演讲转写稿交叉核验一致。
- 适用性/局限：两个可落地原则：① oracle 两侧必须是**各自独立读取的快照**，不能有一侧依赖另一侧刚写完的中间产物（现有 in-tx parity assert 的软肋——fold 读的是"刚被同一 tx 写入的行"，同 tx 内天然强相关，不是真正独立快照）；② **flip 后不要立刻停写旧路径**——保留一段"reverse dual-write"窗口，与 Scientist/GitHub 模式指引完全一致，是本次调研第三个独立来源收敛到同一结论。

**5. Li et al., "Gandalf: An Intelligent, End-to-End Analytics Service for Safe Deployment in Large-Scale Cloud Infrastructure" (USENIX NSDI '20)**
- 要点：把"这次发布安全吗"从人工判断变成自动化统计相关性分析（故障信号 × 发布事件的时空相关算法 + 二分类器），量化精确率/召回率（data-plane 92.4% precision / 100% recall；control-plane 94.9%/99.8%）。
- 权威分级：**USENIX NSDI，系统领域顶会（CCF-A / CORE A*），同行评审**。
- 真实性核验：USENIX 官方会议页 + Microsoft Research 出版页 + ACM DL 三方交叉核验一致。
- 适用性/局限：不是数据迁移论文，但提供本单元最需要的方法论范式——"翻 flag 就绪"不应停留在"人工跑一次 audit:projection 看着干净"，而应是**带阈值、带置信度、可自动化判定**的量化 gate。局限：面向海量遥测信号关联，规模远超本仓库场景，只借用"量化 gate 优于定性判断"原则。

**6. Hanley & Lippman-Hand, "If nothing goes wrong, is everything all right? Interpreting zero numerators" (JAMA, 249:1743-1745, 1983)**
- 要点："Rule of Three"——若 n 次独立观察零次失败，可 95% 置信声称真实失败率上界为 3/n（推导自二项分布 Poisson 近似）。
- 权威分级：JAMA 经典统计方法论文，**同行评审**，医学统计中被极广泛引用（标准工具）。
- 真实性核验：Wikipedia + PMC + scirp 多方交叉核验；核心公式（3/n）在 Wikipedia、Statology、johndcook.com 等独立信源间完全一致复现。
- 适用性/局限：**把"多少 parity 样本才算 ready"从定性变定量的唯一现成数学工具**——若 accept-time in-tx parity assert 在 N 次连续 learning_item 写入零分歧，可 95% 置信声称残留漂移率 < 3/N（N=300 时上界 ≈1%；压到 <0.1% 需 N≈3000）。局限：假设**观察独立同分布**，而 learning_item 写入模式高度不均匀（多数流量集中在少数高频路径，如 complete/relearn），需按写入路径分层计数，否则低频路径（如 archive-retract）会被高频路径"平均"出虚假信心。

### 方向③ fold/replay 确定性验证（oracle 有意义的前提）

**1. Mohan, Haderle, Lindsay, Pirahesh, Schwarz, "ARIES: A Transaction Recovery Method..." (ACM TODS, 17(1):94-162, 1992)**
- 要点：redo（从日志重建状态）必须是**幂等的**——无论从哪个检查点/LSN 重放、重放多少次，最终状态必须唯一确定；这是"日志重建状态"范式能被信任的形式化基石。
- 权威分级：ACM TODS（CCF-A），数据库系统领域被引用最多的论文之一（公认量级为千级，未逐一核对精确数字）。
- 真实性核验：IBM Research 官方出版页 + ACM DL 条目（DOI 可查）交叉核验一致。
- 适用性/局限：`fold(events) == row` 本质是"从日志重建物化视图"，ARIES 给出必须满足的形式化不变量词汇（幂等 redo、日志顺序无关的最终一致状态）。对本单元指引：写 B3 gate 判据前，应先能回答"`gatherAndFoldLearningItem` 对同一 id 反复调用/在事件并发追加时调用，是否保证幂等且与调用时机无关"——若这个前提本身没被显式验证过，parity 样本数再多也可能只是在反复确认一个偶然稳定但理论上不确定的函数。局限：面向数据库内核层物理日志恢复，术语需要转译。

**2. Newcombe, Rath, Zhang, Munteanu, Brooker, Deardeuff, "How Amazon Web Services Uses Formal Methods" (CACM, 58(4):66-73, 2015)**
- 要点：AWS 自 2011 起用 TLA+ 对分布式存储/复制协议做形式化建模检查，多次在生产前捕获深藏、测试难以覆盖的确定性/一致性 bug；核心论点是"当 bug 代价足够高、状态空间足够大时，抽样测试不足以建立信心"。
- 权威分级：CACM "Practice" 栏目，**同行评审**，高引用，界内标志性文章。
- 真实性核验：dblp + ACM DL + Amazon Science 官方出版页三方交叉核验一致。
- 适用性/局限：若 owner 认为 learning_item（"FSRS/mastery-adjacent，blast radius 最大"）值得比纯抽样验证更强信心，可考虑对 `foldLearningItem` reducer 核心不变量（同一 subject_id 下事件重放顺序无关/对已知历史事件集合是全函数不会 partial）做轻量 TLA+/属性测试作为 B3 gate 补充证据。局限：讨论分布式协议正确性，不特化于投影重建。

**3. Kleppmann, *Designing Data-Intensive Applications* (O'Reilly, 2017)，第 11-12 章**
- 要点：任何"从同一份输入流派生多个下游状态"的系统（CQRS/event sourcing/derived data），前提是把输入流处理变成确定性函数——"squeeze all the non-determinism out of the input stream"，非确定性因素必须在事件写入前固化进事件本身。
- 权威分级：**行业标准教材（O'Reilly），非同行评审学术出版物**，但系统工程界广泛视为该主题事实权威综合参考。
- 真实性核验：多个独立读书笔记/大纲页交叉核验章节结构与核心论点一致；未能直接核对逐字引用，标记为**转述级引用**。
- 适用性/局限：本方向最直接可操作的一条——讨论"fold 与 row 是否该 parity"前，应先确认**同一 subject_id 的事件写入本身是否被串行化/确定性排序**（如 learning_item 是否存在并发写入同一 id 导致事件落库顺序在不同副本/重放路径下可能不同的场景）。若前提不成立，即便拿到"独立"第二套 oracle，比较出来的分歧也可能是"事件顺序竞态"而非"reducer bug"，会误导 B3 gate 判读。

### 文献对设计的净指引（原文保留）

三个方向的证据在**同一个结论上收敛**：flip 前的问题不是"要不要验证"，而是"验证双方是否真的独立"。Davis & Weyuker 的 pseudo-oracle 定义、GitHub Scientist 的 control/candidate 模式、Stripe 的双侧独立快照比较，三条完全不同谱系的来源（学术 1981 论文 / 工业 OSS 库 / 2025 年一线工程实践）**独立地**指向同一处方：oracle 的两侧必须能各自成立，其中至少一侧不能是"另一侧运行时顺带产生的东西"。当前 `assertLearningItemParity` 在 OFF 状态下合格（fold vs 独立写的 imperative row），但"flip 后 audit:projection 是唯一 backstop"这句话本身违反这个前提——那时候 fold *是* 唯一的 row 写入者，不再有第二条腿。

具体设计指引（按优先级）：
1. **flip 不等于停写旧路径**（Stripe「reverse dual-write」+ GitHub Scientist「保留 control」两条独立来源同一结论）：`PROJECTION_IS_WRITER_LEARNING_ITEM=1` 之后，建议保留一段时间窗口的"影子 imperative 写"（不影响读路径，只写入 shadow 列/表，供离线比较），把 B3 gate 之后的观察期变成真正的双侧独立验证。
2. **量化 ready 判据，不要定性判断**（Gandalf + LinkedIn Convergence Principles + Rule of Three 三条来源共同支持）：用 Rule of Three 把"N 次连续零分歧"翻译成显式置信区间，并借用 LinkedIn 的"稳态 100%"判据——新写入零分歧 + 存量重 fold 100% 零分歧，两者缺一不可。当前 prod 的 in-tx 断言是 warn-only、未接出可计数指标——这是把 Rule of Three 用起来的前置阻塞项。
3. **flip 前先验证 fold 本身的确定性前提**（ARIES + DDIA）：在跑 B3 gate 之前，应有独立于"和 row 比对"的检查项——`foldLearningItem` 对同一 id 的事件集合重复调用/并发追加时调用是否幂等、结果是否与调用时机无关；以及 learning_item 事件写入是否存在跨副本乱序风险。建议作为 B3 gate 的独立子项（哪怕只是轻量 property-based test：对同一份历史事件集合做多次随机顺序重放，断言输出不变）。
4. **N-version 的警示要求写进设计 doc 的风险自白**：即便按 (1) 补出"第二条独立写路径"，若是对同一份规格的另一次解读（如同一人在同一 PR 系列写的"独立"校验脚本），仍可能与主 reducer 共享同一处规格误解（common-mode failure）。真正独立的信号应来自**业务可观测层**——比较"API 层最终返回给用户的 learning_item 内容"在 fold-as-writer 和 imperative-as-writer 两种模式下是否一致，而不只是比较两条数据库行的结构字段——天然绕开"两段代码共享同一处规格误读"的盲区。

---

## 产品先例（带一手引用）

### 一、GitHub Scientist（github/scientist）—— parallel-run 实验框架

**机制描述**：`control`（旧/权威）与若干 `candidate`（新/待验证）在同一次 `run` 里都执行一遍，各自返回值/异常/耗时包成 `Observation`，两两用 `observations_are_equivalent?` 比较，产出不可变 `Result`（`@control`/`@candidates`/`@mismatched`/`@ignored`），交给 `publish(result)`。**两条硬约束**：① `control.value` 是唯一被返回给调用方的值，且只有 control 抛出的异常才会向上传播；② candidate 的执行被整体吞掉（`begin...rescue *RESCUES => e; @exception = e; end`），**永不传播到调用方**，只作为 mismatch 的一种形态记录进 `@exception`／`equivalent_to?` 比较。`ignore_mismatched_observation?` 允许把"已知的、可解释的"mismatch 从 `@mismatched` 挪进 `@ignored`，与"真正未知的漂移"分层。

**Repo/file/function 级引用**：
- `lib/scientist/experiment.rb` — `run(name=nil)` → `generate_result(name)`（`behaviors.keys.shuffle.each` 打乱执行顺序防缓存类偏差）；`observations_are_equivalent?(a, b)` → `a.equivalent_to?(b, @_scientist_comparator, @_scientist_error_comparator)`；`raise_on_mismatches?` 时 `raise MismatchError.new(self.name, result)`，但 `publish(result)` 总是先跑；`control.value` 是唯一返回值。
- `lib/scientist/observation.rb` — `begin @value = block.call rescue *RESCUES => e; @exception = e end`（candidate 异常被吞，不传播）；`equivalent_to?(other, comparator=nil, error_comparator=nil)` 中 `if raised? || other.raised?` 分支——一方抛错一方没抛即判 mismatch。
- `lib/scientist/result.rb` — `Result.new(experiment, observations, control)` 冻结不可变；`evaluate_candidates` 把非 control 的 observation 分流进 `@mismatched`/`@ignored`。
- （二手，作为使用语境）Scientist 原始设计动机是 GitHub 内部重构权限判定这类"一旦错就是安全事故"的关键路径，parallel-run 时旧路径永远权威、新路径只被动观测——这条产品史与本仓库"imperative row 永远是 SoT，fold 只被动验证"的既有决策同构。

**与本项目约束的适配判断**：本仓库 `parity.ts` 已经**独立收敛到了同一个不变量**——`assertKnowledgeNodeParity` 等函数把 `gatherAndFoldKnowledgeNode` 包在 `try/catch` 里，注释明确写「A reducer/gather throw ... must never abort the live accept in prod」，效果与 Scientist 的 candidate-exception-swallow 完全一致；`onParityMismatch` 的 prod-warn/dev-throw 分级也对应 Scientist 的 `publish` vs `raise_on_mismatches?` 分级。**唯一 Scientist 有而本项目暂无的**：显式的 `ignored` 分层——本项目用 `audit-projection` 的静态 allowlist（`resolves_when`）做同等作用，但那是**离线** allowlist，不是**在线** parity assert 里的 per-call ignore；对 n=1 单用户场景影响很小（accept 频率低，人工能盯住 prod 日志），不建议为了对齐 Scientist 而在热路径引入更复杂的 ignore DSL。Scientist 的"多 candidate、随机采样、百分比灰度"这类多用户/高流量特性，在 n=1 场景下没有意义，不应被抄。

### 二、Axon Framework（AxonIQ/AxonFramework）—— 投影 reset/replay + catch-up 一致性

**机制描述**（跨两个版本读，两条线都有独立价值）：

**(a) 5.x（`main`，2026 重构后）的 reset 前置门**：`ResetHandler.handle(resetContext, context)` 在 replay 真正开始**之前**被调用，用来清空投影状态；文档字面写「If this method completes exceptionally, the reset operation will be aborted and no replay will occur」——**reset 前置钩子失败＝整个 reset 中止**，这是一个独立于「数据是否漂移」的**结构性能力门**。`ResetNotSupportedException` 是专门的异常类型，允许某个 handler 显式声明"我不支持被 reset"。`ReplayToken.concludesReplay(trackingToken)`（`tokenAtReset` 被 `currentToken.covers()` 覆盖时判定 replay 结束）把"replay 是否追平"做成一个纯位置判定，与"值是否正确"严格分离成两个问题。

**(b) 4.9.3（稳定版）的 `resetTokens` 实现**（`messaging/src/main/java/org/axonframework/eventhandling/TrackingEventProcessor.java:682`）：
```java
public <R> void resetTokens(@Nonnull TrackingToken startPosition, R resetContext) {
    Assert.state(supportsReset(), () -> "The handlers assigned to this Processor do not support a reset");
    Assert.state(!isRunning() && activeProcessorThreads() == 0 && !workLauncherRunning.get(),
                 () -> "TrackingProcessor must be shut down before triggering a reset");
    transactionManager.executeInTransaction(() -> {
        int[] segments = tokenStore.fetchSegments(getName());
        TrackingToken[] tokens = new TrackingToken[segments.length];
        for (int i = 0; i < segments.length; i++) tokens[i] = tokenStore.fetchToken(getName(), segments[i]);
        eventHandlerInvoker().performReset(resetContext);
        for (int i = 0; i < tokens.length; i++)
            tokenStore.storeToken(ReplayToken.createReplayToken(tokens[i], startPosition, resetContext), getName(), segments[i]);
    });
}
```
两条 `Assert.state` 是**两种不同性质的门**：`supportsReset()` 是"这个投影结构上能不能被 reset"的能力门（编译期/配置期已知），`!isRunning() && activeProcessorThreads()==0` 是"此刻有没有并发在跑"的运行时互斥门。二者都满足才允许进入"快照所有 segment token → 清空投影 → 重新写回 token"这个**单事务**流程。

**Repo/file/function 级引用**：
- `messaging/src/main/java/org/axonframework/messaging/eventhandling/replay/ResetHandler.java`（5.x, `main`）
- `messaging/src/main/java/org/axonframework/messaging/eventhandling/replay/ResetNotSupportedException.java`（5.x, `main`）
- `messaging/src/main/java/org/axonframework/messaging/eventhandling/processing/streaming/token/ReplayToken.java`（5.x, `main`）—`createReplayToken`/`isReplay`/`concludesReplay`
- `messaging/src/main/java/org/axonframework/eventhandling/TrackingEventProcessor.java:637-706`（4.9.3 tag）—`claimSegment`/`resetTokens`/`supportsReset`

**与本项目约束的适配判断**：本项目现有 `runB3Gate`（`scripts/b3-gate.ts`）已做到 Axon 的"快照→改写→单事务"结构（步骤 1 snapshot id 集 → 2 backfill → 3 audit → 4 `db.transaction((tx) => rebuildProjection(tx))` → 5 survival diff），**这一点是独立收敛而非巧合**——Axon 也是先 `fetchSegments` 快照 token 再在同一事务里改写。但 Axon 有一个本项目**明确缺失**的门：`supportsReset()` 这种**结构能力门**，与"数据是否干净"的 audit 门是分开的两道闸。本项目的 `sot-flag.ts`/`PER_ENTITY_FLAG_ENV` 目前只有"flag 存在与否"，没有一个显式的"这个实体的 fold 结构上是否已经具备承接写入的全部能力（比如 Q3 knowledge_merge 事件消费、prefetch threading 签名）"的独立断言——YUK-543/YUK-547 描述的正是这类**结构性前置**被口头/PR 记忆追踪，而不是像 Axon 那样落成一个可执行的 `supportsReset()`-等价断言。对 n=1 单用户场景，"运行时互斥门"(`!isRunning()`) 直接对应本项目"flip = 改 env + 重启三进程"的现有设计——**这恰好验证了该设计是对的**：重启三进程就是 Axon 意义上的"stop the world"，不需要 Axon 那种运行时并发 segment claim 机制（本项目单进程写、无多副本竞争同一 segment 的问题）。`ReplayToken.concludesReplay()` 这种"追平判定"在本项目里没有必要单独建——因为 parity assert 是**在同一个 accept 事务里**跑的（`parity.ts` 头部注释：assert 在 accept tx 内、rate/generate 写完之后立刻跑），不存在 Axon 那种"异步消费者滞后于写入流"的追赶窗口。

### 三、Marten（JasperFx/marten）—— Postgres 事件日志 + row 投影重建，含真实的"翻转"文档

Marten 是与本项目**架构同构度最高**的真实 OSS：事件存到 Postgres，投影（`SingleStreamProjection` 等）重建出**普通 Postgres 表行**供查询——与本项目"event → fold → knowledge/goal/learning_item 等表行"几乎同形状，且 Marten 官方文档**直接写了"怎么翻转"**。

**机制描述**：
1. **Blue/Green Projection Versioning**（`docs/events/projections/rebuilding.md` §"Blue/Green Deployments with Projection Versioning"）——四步：① `ProjectionVersion` 递增，**新版本写入独立的表**（不是原地重建同一张表）；② 新版本用 Async lifecycle 在旧版本继续对外服务的同时"追平"当前事件序列；③ green 节点与 blue 节点并行跑；④ **"Switch traffic to the green nodes once the new projection has caught up"**——切换时机就是"追平"。`FetchForWriting()` API 在切换窗口期间对命令处理路径提供强一致性，代码不用改。
2. **`WaitForNonStaleDataAsync` 追平 oracle**（`src/Marten/Events/AsyncProjectionTestingExtensions.cs:188-281`）——纯**位置型**追平判据：调用时刻先记录全局/按租户的 `HighWaterMark`（`initial.EventSequenceNumber`），然后轮询 `database.AllProjectionProgress()` 拿每个 shard 持久化的 `ShardState.Sequence`，`isCaughtUp(rows)` 判断"每个已注册 shard 的 sequence ≥ 那一刻的 high-water"，250ms 轮询一次，超时抛 `TimeoutException` 并打印每个 shard 当前进度表。**这个 oracle 只回答"追上了没有"，不回答"值对不对"**——Marten 信任：只要 shard 处理到了序号 N，其投影状态就是正确的，不反过来跟一份"权威行"做 deep-diff。
3. **Optimized Projection Rebuilds**（`rebuilding.md` §"Optimized Projection Rebuilds", 7.30+）——`opts.Events.UseOptimizedProjectionRebuilds = true` 是**显式 opt-in**、需要 schema migration、且文档明说"目前功能有限，只在单一投影覆盖单一事件流时正确"——与本项目 `PER_ENTITY_FLAG_ENV` 每个实体独立翻转、且默认 OFF 直到"自己的 B3 gate 清"的哲学同构。

**Repo/file/function 级引用**：
- `docs/events/projections/rebuilding.md`（JasperFx/marten, `master`，官方文档，随源码同仓库维护，含可点击的 snippet-source 反链到 `src/Marten.Testing/Examples/RebuildRunner.cs`）
- `src/Marten/Events/AsyncProjectionTestingExtensions.cs:188-281` — `WaitForNonStaleDataAsync`/`isCaughtUp`/`ShardState.HighWaterMark`
- `src/Marten/Events/Daemon/ProjectionDaemon.cs` — `RebuildProjectionAsync` 落地类（继承 `JasperFxAsyncDaemon`）

**与本项目约束的适配判断**：这是三个先例里对"B3 gate 该长什么样"判断力最强的一个——Marten 把"翻转"拆成两种截然不同的成熟度：默认 `RebuildProjectionAsync` = 原地重建同一张表（本项目 `rebuildProjection(tx)` 就是这一档），Blue/Green = 双表并行+流量切换（本项目**没有**做，也**不需要**做）。Blue/Green 存在的唯一理由是 Marten 要服务**多节点、有并发流量、不能停机**的生产环境；本项目是**单用户、单进程组、可接受重启窗口**的场景，`docker-compose` 重启三进程的停机成本对 n=1 用户可忽略——精确对应本仓库"defer flip not build"哲学：**Marten 的产品史证明，双写/双表这类复杂度是流量规模驱动的，不是数据正确性驱动的**，本项目现有"单表原地重建+停机翻转"选型不是偷懒，而是与 Marten 的默认档位（非 Blue/Green 档位）严格对齐的正确选型。同时 `WaitForNonStaleDataAsync` 的"位置型"oracle 反过来**衬出本项目 `auditProjection`（`scripts/audit-projection.ts`/B3 gate 步骤 3）的"值型"oracle 更严格**——本项目的风险面（`b3-gate.ts` 头部注释点名的"a mutation-reducer bug"）是 reducer 逻辑错误导致 fold(events) ≠ imperative row 的**值漂移**，不是消费者进度滞后；Marten 只需要位置型 oracle，是因为其 catch-up 场景是**异步消费者追赶写入流**（存在真实滞后窗口），而本项目的 parity assert 是**同步、同事务**执行的（没有滞后窗口），所以"位置追平"在本项目里是恒成立的伪问题，"值是否漂移"才是真正需要 oracle 回答的问题——这从另一独立源头验证了 B3 gate 现有设计（audit 在 rebuild **之前**跑、比较 fold vs 当前 imperative row）打对了靶子，而非抄错了 Marten 的追平模型。

### 产品先例对设计的净指引（原文保留）

三个源码级先例分别独立收敛到了三条与本项目现状**要么已经吻合、要么指出一个明确空白**的结论，没有一条要求推翻现有设计：

1. **"candidate 永不打断 caller"是三方共识，本项目已落地，不需要再加固。** Scientist 的 `rescue *RESCUES`、Axon 的 `performReset` 失败即中止 reset（而非中止运行中的事件流）、本项目 `parity.ts` 对 `gatherAndFold*` 的 try/catch+prod-warn，是同一个不变量的三次独立实现。
2. **本项目缺的是 Axon 式的"结构能力门"，不是更严格的数据漂移检测。** 现有 `sot-flag.ts` 只有"flag 是否为 1"这一维，而 Axon 用 `supportsReset()`+`ResetNotSupportedException` 把"这个投影结构上具不具备被写穿的资格"做成独立于数据审计的、可执行的断言。本项目里 YUK-543（Q3 gather 补全）、YUK-547（prefetch threading 签名）这类前置条件目前靠 worklist 文档口头追踪——一个可执行的、每实体一条的"structural readiness"检查会比现在纯靠人工记忆更接近 Axon 的 `supportsReset()` 模型，且不需要额外运行时机制——可以是 B3 gate 之前的一个**静态**清单校验。
3. **不要抄 Marten 的 Blue/Green，也不要抄 Marten 的位置型追平 oracle——两者都是流量规模驱动的复杂度，本项目的约束（n=1、单进程组、可停机）不触发这个复杂度的存在理由。** 现有"原地重建+三进程重启"选型精确对应 Marten 的默认（非 Blue/Green）档位；现有"值级 diffSnapshots 在同一事务内比较"比 Marten 的位置级追平更严格，且严格得有理由。

一句话收束：这次调研没有找到任何先例支持给 flip oracle 增加新的运行时机制（双写表、异步追平轮询、灰度采样）——三个源头反而共同指向**现有 B3 gate 的骨架（快照→backfill→值级 audit→单事务 rebuild→rowset 存活 diff）已经是这一问题空间里被验证过的正确形状**，唯一有源码级依据、且本项目目前确实空缺的改进方向是补一道独立于"数据是否漂移"的**结构能力门**（对齐 Axon 的 `supportsReset()`），把 YUK-543/YUK-547 这类"必须先做完才能翻"的前置条件从 worklist 文档里的口头记忆，收口成 B3 gate 能读、能挂红的一个显式检查项。

---

## 三腿冲突与一致点

### 强收敛（三腿独立到达同一结论，视为高置信）

1. **"ON 实体的 audit:projection 是 tautological oracle"——三腿从三条完全独立路径独立推出同一结论。** CODE lane 从代码结构直接判定（"用同一套 gather.ts reducer 重新 fold 再比对——本质是『reducer 对自己一致』的 tautological check"）；LIT lane 从学术 oracle 理论推出（Davis & Weyuker pseudo-oracle 独立性违例）；OSS lane 从 Scientist 范式推出（"flip 到 ON 之后如果彻底停写 imperative 路径，就等于把 control 也删除了，比较对象凭空消失"）。三条谱系完全不同（代码审计 / 1981 学术论文 / 2013 工业 OSS）却收敛到同一诊断，是本次调研置信度最高的发现，也是 register 原有 P1 判断的独立复核确认。
2. **"缺一道独立于数据漂移的『结构能力门』"——CODE 与 OSS 独立收敛。** CODE lane 发现 YUK-543/547 这类结构前置（Q3 gather 补全、prefetch threading 签名）只在 Linear/worklist 里口头追踪，无可执行断言；OSS lane 独立从 Axon `supportsReset()`/`ResetNotSupportedException` 模式推出"本项目缺的是结构能力门，不是更严格的数据漂移检测"。两者未互相读取对方产出，却指向同一处空白，且给出互补的具体形态（CODE：静态清单校验；OSS：`supportsReset()`-等价断言）。
3. **B3 gate 骨架本身（快照→backfill→值级 audit→单事务 rebuild→对称 rowset-diff）不需要推翻，需要泛化覆盖面。** CODE lane 从"W1 有、W3-D 无"的结构性缺失角度论证；OSS lane 从 Marten 对照（"本项目值级 diff 比 Marten 位置级追平更严格，且严格得有理由"）论证现有骨架已经是正确形状。两者一致认为问题不在重新设计骨架，而在把它从 2 个实体（knowledge/knowledge_edge）泛化到全部 6 个 flag domain。
4. **"n=1、单进程组、可停机"约束下不需要 Marten 式 Blue/Green 或多副本并发机制。** OSS lane 明确论证；CODE lane 的改动面预估（缺口2+3"复用现成 7 个 gatherAndFoldX 函数，无需碰 reducer 本身"）隐含同一判断——都不建议引入双表/多节点级复杂度。

### 显式冲突／未收敛点（不抹平，留给设计相裁决）

1. **【OSS vs LIT，关于"post-flip 是否需要新的 shadow/dual-write 机制"】**：
   - OSS lane 明确结论："这次调研没有找到任何先例支持给 flip oracle 增加新的运行时机制（**双写表**、异步追平轮询、灰度采样）"——即不建议为 post-flip 验证引入新的双写基础设施。
   - LIT lane 明确结论（净指引第1条）："flip 不等于停写旧路径……建议保留一段时间窗口的『影子 imperative 写』（不影响读路径，只写入一个 shadow 列/表，供离线比较）"——即建议为 post-flip 验证引入 shadow-write（一种轻量级 dual-write）。
   - 两者字面上都在谈"翻转之后是否要额外写一份东西用于比对"，结论方向相反。可能的调和路径：OSS 的"不建议双写表"针对的是 Marten Blue/Green 那种**完整的第二套投影+流量切换**级别的复杂度；LIT 的"shadow write"是**远为轻量**的机制（只写 1 列/1 影子表，不服务任何读流量，纯粹用于离线 diff）。但这个调和是本 dossier 的推测，两条 lane 均未明确讨论这一区分度，**需要设计相显式裁决**："shadow imperative write"到底算不算 OSS lane 所警惕的"新运行时机制"，以及它的成本是否值得在 n=1 场景下承担（尤其是它意味着对已经翻转的 artifact/question_block **回填**这道工序，还是仅对未来翻转的 goal/mistake_variant/learning_item 生效）。
   - 另需注意：OSS 的判断范围主要基于"现有 4 个 OFF 实体尚未翻转"的语境；而 CODE lane 揭示 artifact/question_block **已经**翻转且从未走完整 b3-gate——OSS lane 在给出"不需要新运行时机制"的结论时，其证据链（Scientist/Axon/Marten 三先例）并不知晓这两个实体已经裸奔数天这一事实。这让"是否需要 post-hoc 补一次 shadow-write 或至少一次迟到的 rebuild+对称 parity"成为一个 OSS lane 未覆盖、但 CODE lane 数据支持的独立问题。

2. **【CODE 独有发现未被 LIT/OSS 触及，但直接影响两者建议的适用范围】**：CODE lane 发现的"register 背景陈述本身 stale——real 现状是 2/6 已翻转"这一事实，LIT lane 和 OSS lane 的调研撰写时点均未反映（两条 lane 都在泛泛谈"flip 前/flip 后"的通用场景，未针对"已经在生产裸奔数天的两个实体"给出专门建议，如是否需要紧急补验证、还是可以等到下次统一泛化 b3-gate 时一并处理）。这不是相互矛盾，而是**覆盖盲区**：设计相需要单独决定 artifact/question_block 的补救优先级和方式，不能照搬 LIT/OSS 给"未来翻转实体"设计的判据。

3. **【隐性张力：LIT 的"业务可观测层校验"(N-version 警示) vs OSS 的"三方已有 candidate-swallow 共识不需要再加固"】**：LIT lane 净指引第4条建议增加"API 层最终返回给用户的内容"级别的校验（业务可观测层，绕开"两段代码共享同一处规格误读"盲区）；OSS lane 净指引第1条认为"candidate 永不打断 caller"这一不变量"已经是三方共识，本项目已落地，不需要再加固"。这两条讨论的其实是不同维度（OSS 讲的是"candidate 失败不能传播给 caller"这一异常处理不变量，已经做到；LIT 讲的是"用什么内容做比较判据"这一验证深度问题，尚未做到）——字面不冲突，但读者若不细分维度容易误判"已经够了"，需要在设计 doc 里把这两个维度分开陈述以免歧义。

---

## 设计相输入（净指引 + 开放问题 + 建议的对抗验证角度）

### 净指引（三腿交叉验证后的建议，按优先级）

1. **[P0，强收敛支持] 承认现有 ON 实体（knowledge/knowledge_edge/artifact/question_block）post-flip 的 `audit:projection` 是 tautological check，不是独立 oracle**——这一诊断被 CODE（代码结构）、LIT（学术 oracle 理论）、OSS（Scientist 范式）三条独立路径确认，应作为设计 doc 的核心前提陈述，而非待验证假说。
2. **[P0，CODE×OSS 收敛] 补一道独立于数据漂移的"结构能力门"**（对齐 Axon `supportsReset()` 模式）——把 YUK-543/YUK-547 这类"该实体的 gather 是否已消费全部已知事件类型/是否所有 mutation 站点已接入 guarded write-through"从口头 worklist 记忆，收口成 B3 gate 前的一个可执行静态检查项。这是唯一同时有 CODE 结构性证据和 OSS 源码级先例支持、且被认定"现状确实空缺"的改进方向。
3. **[P1，CODE 独有但证据扎实] 优先补救 artifact/question_block 的验证欠账**——这两个实体已生产运行数天却从未走完整 b3-gate（缺 rebuild+对称 rowset-parity），风险敞口（genesis backfill 范围误判 / 幽灵行复活）从未被检验。设计相需要明确：是"泛化 b3-gate 后回头对这两个实体补跑一次"，还是"设计新机制时一并把这两个实体纳入首批验证对象"。
4. **[P1，CODE×LIT 收敛] git-track 生产 flag 状态**——`docker-compose.mac.yml` 至今 untracked，是最低成本、最直接的一环，三腿均未发现反对理由。
5. **[P2，需设计相裁决] shadow imperative write 是否值得引入**——LIT 建议、OSS 警惕，见上文冲突点1。若设计相认为"轻量 shadow-write（不服务读流量、只供离线 diff）"与 OSS 所警惕的"新运行时机制"性质不同，可采纳；否则应明确记录"经权衡后不采纳 LIT 的 shadow-write 建议，理由是……"，不要静默丢弃这条有具体一手证据（Stripe reverse dual-write + LinkedIn convergence + GitHub Scientist control 保留）支持的建议。
6. **[P2，LIT 独有] 引入 Rule of Three 量化置信区间**，把"N 次零分歧"翻译成显式漂移率上界（如 N=300 ⇒ ≤1%），前提是先把当前 warn-only 的 mismatch 计数接出可观测指标（当前无该指标，是本条的阻塞项）。
7. **[P2，LIT 独有] flip 前验证 fold 本身的确定性前提**（幂等 redo / 事件写入顺序无关）——ARIES/Kleppmann 支持，当前代码库对此零验证，建议至少做一次轻量 property-based test 作为独立子项，而非仅靠"audit clean"。
8. **[P3，CODE 独有，工程量极小] YUK-547 prefetch threading**——`gatherAndFoldLearningItem` 补 `prefetchedMergeEvents?` 参数，消除 audit 场景下 O(N×M) 重复全表扫描，非正确性阻塞但影响 oracle 工具在真实数据量级下的可操作性。
9. **[P3，CODE 独有] 补 prod-warn 分支测试覆盖**（goal/mistake_variant/learning_item 当前唯一可达却零覆盖）+ **翻转顺序运行时护栏**（runbook 里的顺序依赖当前纯靠人读文档）。

### 开放问题（留给设计相决策，非本 dossier 裁定）

1. **shadow imperative write 的必要性与范围**：是否要为已翻转/待翻转实体引入"影子写"，还是认为现有 in-tx parity assert（同事务读取，非真正独立快照——Stripe 明确指出这是软肋）已经足够？如果引入，是所有 6 个 flag domain 统一做，还是只对 blast-radius 最大的 learning_item（"FSRS/mastery-adjacent"）做？
2. **artifact/question_block 的补救时点与方式**：泛化 b3-gate 之后立即补跑一次完整 5 步验证，还是接受"已经跑了数天没出问题"作为事后弱证据、把资源优先投给尚未翻转的 3 个实体？
3. **"结构能力门"的具体断言内容**：Axon 的 `supportsReset()` 是布尔开关，本项目的等价物应该检查什么——是否所有已知事件类型都被 gather 消费？是否所有 mutation 站点都已切到 guarded write-through？是否需要针对每个实体单独定义"就绪清单"（比如 learning_item 的清单必须含"prefetchedMergeEvents 已实现"这一项）？

### 建议的对抗验证角度（供后续验证/审查阶段使用）

1. **对"ON 实体 audit:projection 是 tautological"这一核心诊断做反证尝试**：找一个历史上 audit:projection 真正抓到过 reducer bug 的案例（若存在），检验它抓到的到底是"reducer 逻辑错误"还是"out-of-band 直改行"——如果历史命中案例全部属于后者，三腿的核心论断被进一步坐实；如果存在前者的反例，需要重新评估"tautological"这一判断的强度。
2. **对"n=1 场景不需要 shadow-write/Blue-Green"这一判断做压力测试**：假设 learning_item fold reducer 存在一个隐蔽 bug（如 Q3 无界扫描间接导致的竞态或遗漏），在现有 B3 gate + 无 shadow-write 的设计下，这个 bug 从"翻转生效"到"被任何机制发现"之间的最大延迟是多久？如果答案是"理论上无上限（除非人工肉眼发现业务层异常）"，则需要重新权衡 OSS lane"不需要新运行时机制"这一结论对 learning_item（blast radius 最大）是否同样成立，还是应该按实体差异化处理（低风险实体不需要，高风险实体需要）。
3. **对"结构能力门"设计做覆盖度审查**：列出 YUK-543/544/545/546/547 当前口头描述的所有前置条件，逐条验证提议的"structural readiness 检查"能否机械覆盖（而非遗漏其中某条只能靠人工记忆的隐性前提）。

---

**关键证据文件汇总**：
`src/server/projections/sot-flag.ts`、`src/server/projections/parity.ts`、`src/server/projections/gather.ts`、`scripts/b3-gate.ts`、`scripts/rebuild-projection.ts`、`scripts/audit-projection.ts`、`scripts/audit-projection-allowlist.json`、`docker-compose.mac.yml`（untracked）、`docs/superpowers/plans/2026-06-27-yuk471-w3d-flip-runbook.md`、`PLAN.md:128`、`docs/design/2026-07-02-project-logic-master-register.md`（line 672-674）。

---

## P0-2 补洞：artifact/question_block 生产实测（2026-07-03）

完备性 critic 的 P0：把「artifact/question_block 已翻 ON、跳过 b3-gate 的 rebuild + 对称 rowset-parity、『运行数天无异常』只是推断」这句推断，对生产库真跑一次核对变实测。**全程只读**——docker exec psql `SELECT` + 一段临时 tsx 探针（`/Users/yukoval/.claude/jobs/48153bf9/tmp/foldparity-artifact-qb.ts`，只 `db.select`，跑完 rm 掉 repo 内执行副本，未留 repo 污染）。目标库 = mac compose 生产 postgres（`the-learning-project-postgres-1`，:5433，Up 25h healthy），两 flag 实测 ON（`docker-compose.mac.yml:17-18,22-23`）。repo @ `0291987e`。

### 方法（复用生产同一套 reducer，非另写核对逻辑）

探针对每个实体取 **id 全集 = 活行 ∪ event 的 subject_id**（覆盖 audit:projection 只扫活行所漏的反向「幽灵复活」方向），逐 id 跑 `gatherAndFoldArtifact`/`gatherAndFoldQuestionBlock`（= 生产 IO shell 与 audit:projection 共用的 `gather.ts`）得投影态、映射活行经 `artifactRowToSnapshot`/`questionBlockRowToSnapshot`（含 question_block 的 `extracted_prompt_md` legacy strip）、`diffSnapshots`（= in-tx assert 与 audit 共用的结构 deep-diff，Date/jsonb-key-order 归一）逐字段比对。分类：CLEAN / GHOST（活行在、fold→null）/ MISSING（无活行、fold→非 null，即幽灵复活）/ FIELD-DRIFT。**这是 b3-gate 值级 audit + 对称 rowset-parity 的只读等价物，唯一没做的是 rebuild 的写回 round-trip**（需写库，本任务只读）——但写路径正确性已被本比对间接覆盖：flip 时 `projectArtifact/projectQuestionBlock` 写入的活行若与 fold 有出入即会显为 FIELD-DRIFT。

### 实测结果

| 实体 | 行数 | 事件数 | distinct 事件 subject | 幽灵行(有行无事件) | 缺行(有事件无行) | universe fold-parity | 结论 |
|---|---|---|---|---|---|---|---|
| artifact | 15 | 15 | 15 | 0 | 0 | 15/15 clean, 0 anomaly | **CLEAN** |
| question_block | 69 | 118 | 69 | 0 | 0 | 69/69 clean, 0 anomaly | **CLEAN** |

- **rowset 对称性**（SQL `EXCEPT` 双向）：两实体两方向全 `(none)`——零幽灵行、零缺行。
- **event 构成**：artifact 15 事件全 `experimental:genesis`（无 runtime create/edit/lifecycle→fold 不可能 resolve 成 null）；question_block 118 事件 = `genesis`×69 + `auto_enroll_observed`×40 + `proposal`×9（7 subject），全部 subject 落在那 69 个 block 内（all-action distinct subject = 69 = genesis distinct = 行数），无事件指向表外 id。
- **字段级 fold-parity**：全 id universe（活行 ∪ 事件 subject，两实体各 = 行数，印证 rowset 对称）逐字段比对，**0 anomaly**——无 GHOST（无 fold→null 的活行）、无 MISSING（无幽灵复活）、无 FIELD-DRIFT。

### 结论：CLEAN，不影响 #5 flip 决策

推断变实测：artifact/question_block 在生产上 **fold(events) 与活行逐字段一致，且 rowset 双向对称**。dossier「缺口2」担心的两类风险（① genesis backfill 范围误判致某行被误删；② rebuild 幽灵行复活）在**数据层实测均未发生**——GHOST/MISSING 两类正是这两风险的数据显影，实测计数皆 0。「运行数天无异常」由推断升级为实测确认（截至 2026-07-03）。

**残留（非 P0，不阻塞 flip 决策）**：本次只读比对**不能替代**未来泛化 b3-gate 的 rebuild 写回步骤对 `project*` 写路径 round-trip 的验证；但该写路径已是生产数天的活写者，且 flip 时 live audit:projection 已 CLEAN，敞口极小。dossier「缺口2/3」（把 rebuild+对称-parity 泛化到全 6 实体、并回头补跑 artifact/question_block）作为**工程加固**仍成立，但其**紧急度可降级**——原「两个 ON 实体带未检验敞口裸奔」的 P1 补救诉求，经本实测已确认当前无实际漂移，可并入下次统一泛化 b3-gate 时一并处理，无需紧急单独补救。
