# YUK-1527 — search_bank 向量计入：同话题题簇领先量（规则 v2）比较方案与样本冻结

日期：2026-10-29 · 阶段：规划交付（本轮只交方案与冻结清单，不实施）· 状态：方案稿，待调参集补齐后执行

## 问题

v1 规则（YUK-1516，`src/capabilities/practice/server/tools/bank-vector-retrieval.ts`）要求
向量命中同时过绝对天花板（0.55）与 **top-1 领先量**（rank2 − rank1 ≥ 0.15）才计入
coverage.verdict。margin 的前提假设是 rank-2 为**竞争者**：领先幅度小 = 主题归属存疑。
当题库里同一主题有多道题（题簇）时该假设失效——rank-1/rank-2 是同主题互相印证，
簇内间距天然小，margin 不达标 → 该主题保守判 none → **库里有题却发 gap_request**
（false-none 方向，付费供题被误触发）。这是 YUK-1516 文档「已知代价」明记的遗留病灶。

修这个病灶的危险在对面方向：若放松 margin 的依据是「rank-1 与 rank-2 彼此贴近」，
等差数列题与递推数列题在向量空间近邻、可能共享粗粒度 KC，会把「库里有等差」误判成
「递推够了」——**false-enough**，吞掉 gap_request。本方案的全部设计都围绕这条张力。

## 现状基线（只列 main 已交付，#1969 的 draft 接口不算）

| 事实 | 位置 |
|---|---|
| v1 计入规则：baseline 序列 → rank1≤0.55 且 rank2−rank1≥0.15 计 rank-1 | `bank-vector-retrieval.ts` `bankVectorCountedRank` |
| margin 基线 = 合格库面（顶层/非诊断/无墓碑/未撤回/带向量，**无 scope 过滤**），ORDER BY distance LIMIT 2 | `bankVectorBaselinePredicates()` + `bank-search.ts` 基线查询 |
| verdict = fts 强命中 ∪ 向量 counted；none/sparse 时铸 gap_request | `bank-search.ts` 收尾段 |
| 查重常量 0.35（question↔question 查重轴，与本票检索轴分离） | `quiz/matcher.ts` `MATCHER_COSINE_MAX_DISTANCE` |
| 入库向量近重：相似度 ≥0.93 只产生**待裁决 hold**（`vector_near_dup`），不是既判结论 | `question-supply/ingest-dedup.ts` |
| exact 身份 / 变式家族 / 同组 parts：`canonical_content_hash`、`root_question_id`/`parent_variant_id`、`parent_question_id` | `src/db/schema.ts` question 表 |
| KC 标注：`question.knowledge_ids`（jsonb，标注面叶子 id，GIN 索引） | 同上 |
| 标定 harness（只读、网格、与引擎同源谓词/规则函数） | `scripts/calibrate-bank-vector-threshold.ts` |
| 实测锚点（105 题副本）：文言断句 present 0.422/0.675（margin 0.253）；离子方程式 absent 0.436/0.546（margin 0.110） | `docs/planning/2026-10-17-yuk1516-bank-vector-retrieval-threshold.md` |

## 一、冻结样本（交付 1）

### 1.1 路径缺口（如实记录，不编造数字）

- PM 指定源：`tlp-status/review/stage1-yuk1516-calibration`（及仓库内同源路径）。
- 2026-10-29 本 worktree 勘验：仓库内**无** `tlp-status/`；YUK-1516 文档引用的同源外置
  路径为 `/Volumes/YukovalSBak/yukoval-projects/tlp-status/review/stage1-k7-paid-vector/report.md`，
  该外置卷在本实施环境（Linux）不可达。
- 仓库内可考的同源证据仅两处：上表实测锚点（planning doc）与
  `scripts/fixtures/bank-vector-calibration.sample.json` 的两条锚点 query（expected id 为占位）。
- 因此本轮冻结 = **组合契约 + 仓库内锚点入册 + 待补条目显式登记 + 补齐程序 + 不变性规则**，
  不产出任何新数字。距离数字只允许来自 stage1 既有产物或后续经批准的标定运行。

### 1.2 三个集与层配额（最低配额，binding）

| 集 | 用途 | 层（stratum）与最低条数 |
|---|---|---|
| 调参集 `tuning-set.json` | 挑参**唯一**数据源，可反复看 | present_single ≥6 · present_cluster ≥6 · absent ≥6 · adjacent_trap ≥4 |
| 验证集 `validation-set.json` | 定稿后**只看一次** | 同上配额；条目不得与调参集重复、不得是调参集 query 的同义改写 |
| 换说法集 `paraphrase-set.json` | 一次性验证计入不依赖题干词面重叠 | present_single ≥4 · present_cluster ≥4 · absent ≥4 |

层定义（冻结标签 = ground truth，由 lead 依据权威信号或人工判定填写；机器证据臂只负责预测它）：

- `present_single`：主题在库，expected 为孤立单题（无同主题伴题）。v1 已能处理，防回归。
- `present_cluster`：主题在库，≥2 道同主题题（`cluster_member_ids` 标注簇内成员）。
  **v1 的病灶层**：v2 必须把 counted id 计入 expected。
- `absent`：主题整体缺位（跨科或无关联）。v1 靠小 margin 保护，v2 必须保持不计入。
- `adjacent_trap`：主题缺位，但**存在同 KC 的兄弟主题题簇**贴近查询（典型：递推查询
  vs 等差数列簇）。v1 靠 margin 挡住；v2 的题簇分支最容易被诱使 false-count。**杀手层**，
  期望任何参数下都不计入。

配额可行性：105 题副本若供不满某层（尤其 present_cluster / adjacent_trap），lead 在
MANIFEST 如实登记缺口与实际条数——**不得静默降配**；可按 §1.4 程序扩展新标注补足。

### 1.3 「不含题干原词」操作定义（换说法集准入线）

对每条 entry 的每个 expected 题取 `prompt_md` 的 CJK 字 bigram 集合；query 的字 bigram
集合与**任一** expected 题题干 bigram 集合的 Jaccard 重叠 ≤ 0.2。absent 条目同样不得与
库中最近邻题题干超过该重叠（防词面泄漏把 absent 变简单）。逐条实测值在冻结时记入
entry 的 `stem_overlap` 字段。判定属补齐程序一部分，本轮只定契约。

### 1.4 冻结文件、格式与补齐程序

冻结落位 `docs/planning/2026-10-29-yuk1527-cluster-margin-samples/`：
`tuning-set.json` / `validation-set.json` / `paraphrase-set.json` / `MANIFEST.md`。
JSON 与 `CalibrationFileSchema`（标定脚本）同形扩展：entry 增 `stratum`、
`cluster_member_ids?`、`status: frozen | pending_external_fill`、`fill_from?`、
`stem_overlap?`；`expected_question_ids` 为空在 `status=pending_external_fill` 时表示
「未填」而非「absent」，**filled 语义以 status 为准**。

补齐程序（lead 执行，本轮不跑付费 embed）：

1. 将 `tlp-status/review/stage1-yuk1516-calibration`（及 stage1-k7 报告）拷贝到仓库可读
   位置或在可读环境操作；按 §1.2 配额填三个 JSON。先填调参集；验证集与换说法集条目
   对调参执行者**物理隔离**（分文件、不进调参脚本输入路径）。
2. 仓库内锚点（文言断句 / 离子方程式）expected id 与簇结构从 stage1 产物核实后升 `frozen`。
3. `sha256sum` 三文件写入 MANIFEST。此后三文件只读：任何修改 = 作废重冻（新目录+新
   MANIFEST），已用过的验证集/换说法集作废须重新标注替换。
4. 纪律条款：**三文件全部 frozen 且 MANIFEST 记录 SHA256 之前，任何调参运行不得开始**。

## 二、同话题题簇比较方案（交付 2）

### 2.1 独立证据：sameTopic(q1, q2) 的机器可测信号

三条证据全部 **query-independent**（不依赖本次查询向量，只依赖题的既有事实）：

1. **权威查重结论**（最高优先）：
   - 同变式家族：`root_question_id` / `parent_variant_id` 同根 ⇒ 定义上同话题；
   - 同组 parts：`parent_question_id` 同组 ⇒ 同题；
   - exact 查重：`canonical_content_hash` 相同 ⇒ 同题。
   - 入库向量近重 hold（≥0.93）**不算**：它是待裁决记录而非既判结论，不进初始组合，
     留作后续扩展项（前提：先有裁决态）。
2. **共享知识点**：两题 `knowledge_ids` **标注面叶子 id 交集非空**。明确边界：只比实际
   标注集合，**不向上折叠祖先域**——等差数列与递推数列共享祖先「数列」KC 不构成证据。
   无 KC 标注 = 该证据不可用（不视为反证）。
3. **题间向量距离 q↔q**（仅辅助，**方向不对称**）：可作**否证**——q↔q 距离大于上界 ⇒
   直接判不同话题（挡 KC 标注错误）；**禁止作证实**——「q↔q 距离小 ⇒ 同话题」被本方案
   明文排除出公式空间，不进网格。理由：等差/递推内容空间近邻但不同主题，距离小不携带
   主题同一性的信息。

### 2.2 比较臂（同一冻结调参集上对照）

| 臂 | sameTopic 定义 | 意图 |
|---|---|---|
| A0 | ——（v1 原样） | 基线：确认病灶（present_cluster 漏报）与既有保护（absent 挡住） |
| A1 | 仅权威查重结论 | 最窄证据：变式/同组/exact 同题才算簇。查全低、精度高 |
| A2 | A1 ∪ 共享叶 KC | 覆盖无家族关系但同 KC 的簇；引入等差/递推误并风险，靠杀手层暴露 |
| A3 | A2 + q↔q 距离否证 guard | 用否证方向修剪 A2 的 KC 标注错误 |

A0–A3 共用同一网格搜索流程（§2.4）；胜出臂进验证集一次性复测。

### 2.3 规则 v2 草图（伪代码，不实施；胜出臂才有实施 PR）

```
countedRankV2(baselineTopK 升序, sameTopic, params):
  if 行数 < 2:        null                      # 不变：无竞争者证据不计入
  if rank1 > maxDistance: null                  # 不变：绝对天花板
  if rank2 − rank1 ≥ margin: return rank1       # 不变：decisive 领先照旧计入
  # —— v2 新增题簇分支 ——
  C = 从 rank1 起、在 top-K 有界窗口内用 sameTopic 闭包扩展的簇（K 进网格）
  if rank2 ∉ C:      null                      # 贴近者是不同话题 ⇒ 歧义仍在
  firstOutside = C 之外最近 baseline 命中
  if firstOutside 不存在: return rank1          # 合格库面整个是该簇 ⇒ 无外部竞争者
  return firstOutside − rank1 ≥ clusterMargin ? rank1 : null
```

语义约束：`match_evidence` / `counted_pool_size` / verdict 判据不变；只改向量计入规则本体，
`BANK_VECTOR_RETRIEVAL_RULE_VERSION` 升 2；游标（v3，带 vd/vc）15 分钟 TTL 内还原旧行为、
新检索走新规则，实施 PR 核对不破坏结构。保守方向不变：拿不准 ⇒ none + gap_request。

**已知风险如实写明**：题簇分支对 absent 主题重新开窗——若缺位主题的近邻恰好构成同 KC
簇（adjacent_trap 构型），簇内印证会被误读为「主题成立」。这正是 A2/A3 必须过杀手层的
原因，也是 §2.5 硬约束设为 false_enough = 0 的原因；若没有任何臂能在杀手层全零的同时
修复 present_cluster，**v2 不上线，v1 保持**（可证伪回退）。

### 2.4 网格与调参纪律

- 网格：`maxDistance × margin × clusterMargin × 簇窗口 K ×（A3 的）q↔q 否证上界`；
  A1/A2 用其子空间。现行锚点（margin 0.253 vs 0.110）为网格中心参照，不改 PROVISIONAL
  定位（YUK-1516 §参数）。
- 挑参**只看调参集**。目标函数分层：① `false_enough = 0`（硬，absent ∪ adjacent_trap）；
  ② present_cluster recall 最大化；③ `precision_when_counted` 目标 1.0——低于 1.0 的
  胜出点须附逐例误计入清单交 owner 裁决，不得静默接受。
- **验证集只看一次**：胜出臂+定稿参数在 validation-set 单次运行报告同套指标；此后任何
  再调参 ⇒ 验证集作废重冻（§1.4.3）。换说法集同样一次性、不反馈调参。
- 运行边界：全部评测只读既有距离产物；新 query 需新 embed 的，走另行批准的付费标定
  运行（本票本轮不跑）。

### 2.5 指标（含单向量召回单独报告）

| 指标 | 定义 | 阈值/用途 |
|---|---|---|
| `false_enough` | absent ∪ adjacent_trap 条目被计入的条数 | **硬约束 = 0**（三个集都是）；非 0 参数点直接出局 |
| `cluster_query_recall` | present_cluster 条目 counted id ∈ expected 的比率 | v2 相对 v1（A0）的修复量，分 stratum 报告 |
| `query_recall` | present_single 同口径 | 防 v1 已能处理的部分回归 |
| `precision_when_counted` | counted id ∈ expected 的比率 | 目标 1.0；误计入单独列 adjacent 诱因 |
| `spurious_gap_rate` | present 条目 fused verdict ≠ enough（gap_request 误发）的比率 | 产品级病灶指标：v1 在 present_cluster 上应显著 >0 |
| **单向量召回（单独报告）** | 以上全部先在**仅向量通道**（baseline 序列上评 countedRank 纯函数，无 FTS 融合）计算 | 与融合链路结果**分开列两套数字，不得混算**——防 FTS 强命中掩盖向量规则的 false-none |

`spurious_gap_rate` 的融合列仅作产品影响观测，不参与挑参（挑参只看单向量列）。

## 三、对齐约束（交付 3，binding）

1. **唯一比较面**：所有比较/标定只用唯一 search_bank v2 链路的结果与共享谓词构建器
   （`bankVectorBaselinePredicates`）——不另起第二套检索路径产 ranking；标定 harness
   延续「与引擎同源谓词/同源规则函数」的单一真相模式。
2. **不恢复第二套 matcher**：查重证据只读既有产物（变式家族、canonical hash、同组、
   0.35 查重轴常量），不新建 question↔question matcher，不改 `MATCHER_COSINE_MAX_DISTANCE`。
3. **不用旧 v1 领先量规则冒充新链路**：v1（0.55/0.15）保持现状；v2 只在后续实施 PR 以
   `RULE_VERSION=2` 落地；本文伪代码不是已交付行为。
4. **与 #1969 恢复线（YUK-1448，OPEN）对齐**：#1969 明文「原距离 0.55、top-1 margin 及
   校准文件未改；旧 counted 标记不决定 v2 semantic matched」。共享 search/schema 面
   （search_bank 输出 schema、通道结构、coverage 口径）以 #1969 落地版为准；本票 v2
   实施 PR 必须 rebase 于 #1969 合入后的 main，不预改其接口。**#1969 现为 draft（未合
   main），本文引用其文件名/行为仅为对齐说明，不得当作 main 已交付**（§现状基线只列
   main 事实即为此）。
5. **不对齐 draft**：本票不依赖、不改变 draft 状态轴（draft_state scope 语义、baseline
   面含 draft 的现状维持 #1969 落地版）；题簇证据不拿 `draft_status` 当输入。

## 四、本轮不做

- 不实现 v2 计入规则代码（本文伪代码/类型草图除外，见附录）。
- 不加测试、不跑付费模型/embedding/付费 smoke、不另开 matcher。
- 不改 matcher、不动 #1969 的任何文件、不合并任何 PR。

## 附录：类型草图（实施 PR 定稿）

```ts
// 仅草图 —— 表达数据结构，不是实现承诺
interface ClusterEvidenceInput {
  /** 合格库面上按 cosine 距离升序的有界截头（rank-1..K）。 */
  readonly baselineTopK: ReadonlyArray<{ id: string; distance: number }>;
  /** 独立证据组合（只读既有产物；「距离小⇒同话题」方向被禁止）。 */
  readonly sameTopic: (a: string, b: string) => boolean;
}
interface BankVectorRetrievalParamsV2 extends BankVectorRetrievalParams {
  /** 簇外首个竞争者所需领先幅度。 */
  readonly clusterMargin: number;
  /** 簇闭包扩展的有界窗口（top-K）。 */
  readonly clusterTopK: number;
  /** q↔q 否证上界（仅 A3；只用于否证方向）。 */
  readonly pairDistanceGuard?: number;
}
```
