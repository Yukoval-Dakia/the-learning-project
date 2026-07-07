# YUK-579 — 供题治理覆盖细目表（coverage lattice 只读观测面）

> Lane J / Wave 3。**只读观测面，零 LLM · 零 schema · 零新写路径 · 零新查询子系统。**
> 状态：**Phase 1 draft 已过对抗面板（方向批准 + 3 mustFix + 7 should，已全部落地本 doc）→ 进 Phase 2 TDD。**
> 作者：Lane J（worktree `agent-aec83c2783ebd58d0`，PR 分支将用 `yuk-579-coverage-lattice`）。

## 0.0 对抗面板判词（3 挑战者 + Opus 仲裁，全 code-ground）

**方向批准**：四红线核实无违反；两区分离在数据模型层确属诚实（`scanCoverageGaps` 四规则实为
per-KC 池级判据，`target-discovery.ts:401` 零池 `continue` 是真短路非伪造，池级布尔从 gapKind
反读的等价成立）。§10 六决策 + Q① 读模型诚实 + Q④ 注记进 v1 全部认可。**3 mustFix 修完即进
Phase 2**——以下已全部落地本 doc：

- **MF1（§4）**：活动注记禁用逐-target `recentDispatchExists`（dispatcher.ts:112-131 是
  `select({id}).limit(1)` dispatched-only bool 探针，逐调 = +N 串行 + 丢 manual/skipped/failed
  语境）→ 改**单条按 fingerprint 聚合查询** + `import SUPPLY_DISPATCH_COOLDOWN_DAYS`（:63 已 export）
  + 删「复用 dispatcher 探针形状」假陈述、软化「从未派」→「无派发记录」。
- **MF2（§5/§7）**：本页 useQuery **不设 `refetchInterval`** + 顶部「重新扫描」按钮（否则镜像
  60s 轮询先例 → 每 60s 重跑 3N-5N 串行扫描打单 Postgres，与「不缓存」自相矛盾）。
- **MF3（§7）**：desired 坐标**禁止 column-aligned 成矩阵**、frontier_zero 硬编 band/tier 置灰标
  「default scaffold, not scanned」、未评估轴渲显式 chip——散文免责**编码进渲染 artifact**。

7 should（近零成本诚实/一致性精修，随实施顺带）已并入对应节：#1 confusable 边界措辞（§5/§7.0）
· #2 usableCount 单源 + 一致性单测（§2.5/§9）· #3 共享引擎触点 + 回归 gate（§3/§9）· #4 陈旧
壳文件头就地替换（§6/§8）· #5 导航补齐五链含 subjects（§8）· #6 `scan_ms` 遥测（§2.5/§5）·
#7 Zone B defer 真因标注（§2.4/§11）。**拒绝项**（不改）：LIGHT 扁平缺口表作 co-equal fork（拒：
只显缺口 = under-delivery）；confusable 事件不匹配 fingerprint 被 §4 丢弃当缺陷（拒：正确无害，
仅措辞入 should#1）。

---

## 0. Scope 与红线（权威边界，违反即废）

把 `scanCoverageGaps`／`discoverSupplyTargets` 已经在扫的 KC × kind × difficultyBand ×
source-tier 四维覆盖点阵，渲染成 owner 可见的只读「教研蓝图」——挂 admin 观测面（runs /
cost / failures / subjects）旁做**第五面**。

攻击轮写死的红线：
1. **不引入 cognitive-level / Bloom 轴**——数据模型无此轴，不为显示面造新轴。
2. **不动 cooldown**——7d 固定必须保留（本单只读它，绝不改它）。
3. **「痛点优先级调 `computePriority`」是独立 follow-up，不进本单。**
4. **本单价值全在可见性，别顺手加「智能」。**

owner 今日已拍的三决策（UI design pre-flight 已过，无需再等批）：
1. **归属 = admin 第五页**（走先例 B：`admin-subjects.ts` T4b 套路）。
2. **首版形态 = 朴素分组只读 table**（Card + PageHeader + Stateful + 原生 table + inline
   `CSSProperties` 走 tokens；**不做 heatmap，二期再议**）。
3. **壳形态跟 `observability/AGENTS.md` 现状**（admin 套主 chrome），本单补一段 design note
   收口 visual-gap audit 与 AGENTS.md 之间的无记录矛盾（见 §6）。

---

## 1. Grounded 工程事实（动手前已核实）

### 1.1 扫描器只产缺口，四条规则全是「KC 池级」判据
`src/server/question-supply/target-discovery.ts`：`scanCoverageGaps(input)` 对每个 active-goal
KC 跑四条规则，**每条都是对该 KC 的整池（pool-level）判断，不是逐格（per-cell）扫描**：

| 规则 | 判据 | 判据层级 | 触发 gapKind |
|------|------|---------|-------------|
| R1 | `pool.length < COVERAGE_DEPTH_THRESHOLD`（=2） | KC 池计数 | `frontier_zero` |
| R2 | `!pool.some(tier ≤ 2)`（无中高获取档题） | KC 池 | `source_quality` |
| R3 | `!pool.some(effectiveB 落 'near' band)` | KC 池 | `diagnostic` |
| R4 | `pool.every(isRecallKind)`（只有背诵题） | KC 池 | `format_diversity` |

关键短路语义：**零题 KC 只发 R1 然后 `continue`**（无池可分析 R2/R3/R4）；1 题的 thin KC
既发 R1（补深度）也走 R2–R4。所以「四维点阵」是概念框架——扫描器实际吐的是**每个缺口
target 携带一个 desired `(kind, difficultyBand, minSourceTier)` 坐标 + gapKind**，那是「想补的
格」的坐标，**不是对已存在格的覆盖扫描**。扫描器**从不产「已覆盖格」**。

### 1.2 派题事件 `experimental:question_supply`（历史活动源）
- **写入方**：`dispatcher.ts:337-371` `dispatchSupplyTarget` 里 `writeEvent(...)`，每 target 每次
  派发（dispatched / manual / skipped / failed 全都写）一条，try/catch 非致命。
- **落表**：`event`（`schema.ts:793-850`）。`action='experimental:question_supply'`。
- **payload 形状**（`dispatcher.ts:352-370`）：`target_id, fingerprint, gap_kind, subject_id,
  knowledge_ids[], kind, difficulty_band, desired_count, min_source_tier, priority, route_plan,
  chosen_route, status, job_id, stop_condition, reason, constraints`。注意字段是 snake：`gap_kind`
  （非 `gapKind`），`knowledge_ids` 是数组（锚 `[0]`）。
- **索引**：`event_action_outcome_idx (action, outcome, created_at desc)` + GIN `event_payload_idx`。
  → 按 `action` + 时间窗过滤是 index-backed，便宜。
- **现有 reader？无**。本面是这些事件的**首个 reader**。

### 1.3 7d cooldown = 从事件派生（无专表）
`dispatcher.ts` `SUPPLY_DISPATCH_COOLDOWN_DAYS = 7`。`recentDispatchExists(:112-131)` 查
`event WHERE action='experimental:question_supply' AND created_at ≥ cutoff AND
payload->>'fingerprint' = $1 AND payload->>'status'='dispatched'`。**cooldown 状态即事件本身**
（`payload.status='dispatched'` 的行 = cooldown 凭证），无 SoT 替身。→ 「上次派题 / 是否在
cooldown」全从 `event` 派生。

### 1.4 数据量级 + 活扫描成本
- **量级**：单用户工具，**hundreds of KC nodes**（`domain.ts:57` 权威 in-code 估计）。seed/fixture
  非生产代表（`seed-synthetic.ts` 仅 8 节点）。
- **`discoverSupplyTargets` 成本**：`loadFrontierKnowledge` 有一个**全串行** `for (kid of
  candidateKids)` 循环，每 KC 串行 await 3 次（`getMasteryState` 1 query + `getEffectiveDomain`
  1–depth 祖先走查 + `globalThetaForDomain` 1 query，`HIERARCHICAL_ELO_ENABLED=true`）；
  `loadQuestionPool` 是 2 个 query（池 OR-`@>` + 批量 item_calibration），非 per-KC。
  → 总 ≈ `1 + N×(3–5 串行) + 2 ≈ 3N–5N` 串行 round-trip。hundreds 量级 → 数百至 ~1–1.5k 串行
  查询/请求，每查便宜但串行，延迟随 KC 数线性。**这就是真活扫描跑在夜间 job 的原因。**

### 1.5 admin 壳形态的成文冲突（本单要收口的对象）
- **shipped 现实**：`web/src/router.tsx` 里**每条**路由都是 `rootRoute`（component=`RootShell`）
  的孩子——SPA **根本没有独立 admin 壳**；四个 admin 页已经套主 chrome。`router.tsx:440-442`
  注「owner 已拍板收编」；`observability/AGENTS.md:22` 已写「admin 路由照常套主 chrome；不另设
  admin 独立壳」。
- **未收口的旧文**：`docs/audit/2026-06-13-visual-gap.md:146,282`（决策点③）仍留「**SPA 收编主
  chrome 时 admin 套不套主 chrome 必须显式拍板**」；`observability.tsx:5-10` / `subjects.tsx:26-30`
  文件头仍带「Phase-deferred 壳形态决策点… admin is a separate shell」的陈述；loom 设计源
  `app.jsx:146`「// admin is a separate shell — no main app chrome」（audit 引的 `:106-114` 有~40 行
  引用漂移）。→ **owner 的实际决定（主 chrome，已落 router+AGENTS）从未写进一条决策记录**，于是
  audit 的「须拍板」和陈旧文件头悬着不对齐。§6 的 note 就是补录这条决策。

---

## 2. 读模型形状与「已覆盖格」的诚实计算（开放问题 ①）

**核心诚实约束**：扫描器不产逐格覆盖判据，**绝不为逐格显示发明数据里不存在的逐格语义**。
解法 = **两区分离 + 一个免漂移的洞察**：

### 2.1 免漂移洞察：池级布尔判据 ≡ 哪些 gapKind 触发
每条规则「事实缺失 ⟺ 发对应 gapKind」是**定义性等价**：
- `belowDepthThreshold` ⟺ 有 `frontier_zero` 缺口
- `!hasHighTier`（源质量差）⟺ 有 `source_quality` 缺口
- `!hasNearThetaAnchor`（诊断缺口）⟺ 有 `diagnostic` 缺口
- `allRecall`（题型单一）⟺ 有 `format_diversity` 缺口

所以池级布尔判据**从 emitted targets 读出即可，无需在读模型里重算谓词**（不复制
`acquisitionTierForQuestion` / `difficultyBandFor` / `isRecallKind` → 零漂移风险）。只有裸事实
（`usableCount = 该 KC 池题数`、`θ̂`、`evidenceCount`）直接取自 `ScanInput`。**零题 KC 的
诚实特例**：扫描器短路（只发 frontier_zero），故 R2/R3/R4 三维标 `null`「未评估（无池）」，
**绝不假报「已覆盖」**。

### 2.2 Zone A —— KC 池级覆盖行（诚实判词层，v1 主体）
每个 active-goal KC 一行，渲染扫描器实际算的池级判词。这里**不出任何「已覆盖格」矩阵**——一个
KC 一个判词向量，绝不冒充逐格覆盖。

### 2.3 缺口 target 明细（emitted targets，四轴坐标落点）
每 KC 的 `QuestionSupplyTarget[]`——每条携带 desired `(kind, difficultyBand, minSourceTier)` +
gapKind + priority + desiredCount + reason + route + §4 的活动注记。**四维点阵的
kind×band×tier 三轴就活在这里**（= 扫描器字面要补的「格」坐标），**诚实——因为这是扫描器真吐的
获取请求，不是对已存在格的扫描。**

### 2.4 Zone B —— 存量池逐格 census（**推荐 v1 不做，二期**）
理论上可诚实地展示：每 KC 的存量题在 kind×band×tier 上的**描述性计数**（「有什么题」的事实
交叉表，显式标注「描述性 census，非覆盖判词」，0 计数格 = 空，不标「gap」）。但这正是 heatmap
矩阵形态——owner 决策 #2 明说「不做 heatmap，二期再议」。**推荐 v1 只出 Zone A + 缺口明细；
Zone B census 矩阵 = v2 自然演化点。**

**should#7 defer 真因标注**：Zone B defer = **纯 form/scope 纪律（owner 不做 heatmap），非数据/
架构缺口**。census 是 `assembleScanInput().questions` 的**纯内存 group-by**（kind × band × tier），
v2 **零新 IO / 零新 loader**——`assembleScanInput` 已经把整池题捞回内存，Zone B 只是换个投影。
特此标注，免后人在 v2 误读为数据缺口而误建新查询子系统。

### 2.5 读模型 TS 形状（提案）
```ts
interface CoverageLatticeRead {
  generated_at: string;              // ISO —— 这是一次 LIVE 扫描的时刻戳（诚实披露非缓存）
  scan_ms: number;                   // should#6：Date.now() 包 assembleScanInput 的实测耗时，
                                     //   与 generated_at 并列 —— 诚实披露延迟 + 补 nightly job
                                     //   从不计时的缺失遥测，作 TTL 是否需要的实测依据
  coverage_depth_threshold: number;  // COVERAGE_DEPTH_THRESHOLD(2)，UI 不硬编码
  near_window: number;               // NEAR_WINDOW(0.75) —— band 数学的诚实披露
  cooldown_days: number;             // SUPPLY_DISPATCH_COOLDOWN_DAYS(7)，UI 不硬编码（MF1）
  subjects: SubjectCoverage[];
  totals: {
    activeKcs: number; kcsWithGaps: number; totalGaps: number;
    gapsByKind: Record<SupplyGapKind, number>;
  };
}
interface SubjectCoverage { subjectId: string; displayName: string | null; kcs: KcCoverageRow[]; }
interface KcCoverageRow {
  knowledgeId: string; thetaHat: number; evidenceCount: number;
  // should#2：usableCount **单源**于 scanCoverageGaps 用的同一 questionsByKid 分桶
  //   （target-discovery.ts:328-335），绝不独立重数（否则与扫描器判据源漂移）。
  usableCount: number;                 // 该 KC 非草稿可用题数（= 该 KC 桶 length）
  // 池级判词：布尔 = 事实充分；null = 无池未评估（零题 KC 短路）
  depthMet: boolean;                   // usableCount ≥ threshold（!frontier_zero）
  hasHighTier: boolean | null;         // R2
  hasNearThetaAnchor: boolean | null;  // R3
  formatDiverse: boolean | null;       // R4（!allRecall）
  gapKinds: SupplyGapKind[];
  gaps: LatticeGap[];
}
interface LatticeGap {
  gapKind: SupplyGapKind; kind: string; difficultyBand: DifficultyBand; minSourceTier: 1|2|3;
  desiredCount: number; priority: number; reason: string; fingerprint: string;
  routePreference: SupplyRoute[];
  lastActivity: GapActivity | null;    // §4 注记，无派发记录 → null
}
// MF1：从单条 fingerprint 聚合派生。lastActivity/lastStatus = 每 fingerprint **最新一条**
//   （任意 status）；inCooldown/cooldownUntil **只**从最近 status='dispatched' 的事件算
//   （cooldown 凭证 = dispatched 行，dispatcher.ts:331-333）。
interface GapActivity {
  lastActivityAt: string | null;       // 最新事件（任意 status）时刻
  lastStatus: string;                  // 最新事件 status：dispatched|manual|skipped|failed
  lastDispatchedAt: string | null;     // 最近 status='dispatched' 事件时刻（无 → null）
  inCooldown: boolean;                 // lastDispatchedAt 在 cooldown_days 窗口内
  cooldownUntil: string | null;        // lastDispatchedAt + cooldown_days（inCooldown 时非空）
}
```

**读模型组装管线**（单次 DB 遍历 + 纯变换 + 一个便宜事件查询）：
1. `assembleScanInput(db)` → `ScanInput`（复用私有 loader，见 §3）。
2. 纯 `scanCoverageGaps(scanInput)` → targets（内存，零 IO）。
3. 纯逐 KC 事实：`usableCount/θ̂/evidence` 取自 scanInput；池级布尔从 targets 的 gapKind 反读（§2.1）。
4. 一个 index-backed 事件查询 → 按 fingerprint 的 last activity → 注记 gaps（§4）。
5. 按 subject → KC 分组 + 算 totals。
**步骤 2/3/5（给定 scanInput + targets + activity map 的纯变换）= 单测靶（Phase 2 RED）。**

---

## 3. Loader 导出策略（开放问题 ②）——推荐 option (b)

现状：`loadFrontierKnowledge`(:554) / `loadQuestionPool`(:608) 私有未导出；`discoverSupplyTargets`
导出但只吐 targets（缺口），拿不到 `ScanInput`（frontier + pool）。

**推荐 (b)：新增导出 `async function assembleScanInput(db): Promise<ScanInput>`**——把
`discoverSupplyTargets` 里「loader 调用 + routePreference/generationMethod 播种」的组装部分**上提**
成一个纯组装函数；`discoverSupplyTargets` 重构为 `scanCoverageGaps(await assembleScanInput(db),
makeId)`。行为等价（受既有 `target-discovery` db test 守护）。两个 loader **保持私有**，**零新查询
子系统**（只复用既有 reader）。读模型消费 `assembleScanInput` + 纯 `scanCoverageGaps`。
另导出 `COVERAGE_DEPTH_THRESHOLD`（纯值，供 UI 披露阈值，免魔数漂移）。

对比 (a) 直接导出两 loader：泄露内部形状、读模型要自己重播 routePreference——(b) 更内聚。

**should#3 — 唯一触及共享生产发现引擎的改动，须显式回归 gate**：`assembleScanInput` 重构
`discoverSupplyTargets`，而 `discoverSupplyTargets` 被**生产夜间派题链
`src/capabilities/practice/jobs/question_supply_nightly.ts:107` 消费**——这是本「零新写路径」单里
**唯一**动到共享生产代码的点。行为等价性靠**既有 `target-discovery` db test 守护**：Phase 2 lane
须把该 db test 当**重构回归 gate 显式跑**（不只靠全量 `pnpm test` 顺带），确认 `assembleScanInput`
+ `scanCoverageGaps` 组合与旧 `discoverSupplyTargets` 逐字节等价。

---

## 4. `experimental:question_supply` 历史事件的角色（开放问题 ④）——v1 接入（MF1 已修）

**v1 接入一条「最近供给活动」注记**（面板认可进 v1）。**MF1 —— 查询形态钉死为单条聚合，禁用逐
target 探针**：

- **禁止逐 target 复用 `recentDispatchExists`**（dispatcher.ts:112-131 是 `select({id}).limit(1)`
  的 **dispatched-only bool 探针**——逐 target 调 = **+N 串行查询**且**丢 manual/skipped/failed
  语境**，两头都错）。
- 改**一条按 fingerprint 聚合的查询**：`WHERE action='experimental:question_supply' AND
  created_at ≥ cutoff`（**无 status 过滤**；`cutoff = now − max(30d, cooldown_days)`，30d 稳落
  `event_action_outcome_idx (action, outcome, created_at desc)`），拉回后**内存按
  `payload->>'fingerprint'` 聚合**（DISTINCT-ON-fingerprint 语义）。
- `lastActivityAt` / `lastStatus` 取每 fingerprint **最新一条（任意 status）**；
  `inCooldown` / `cooldownUntil` **只**从最近 `status='dispatched'` 事件算（cooldown 凭证 =
  dispatched 行，dispatcher.ts:331-333）。
- **`import SUPPLY_DISPATCH_COOLDOWN_DAYS`**（dispatcher.ts:63 已 export）→ 读模型 `cooldown_days`
  字段 + cooldown 窗口计算**别硬编 7**。
- **删假陈述**：§1.3 曾述「直接复用 dispatcher cooldown 探针查询形状」——**改述为「本面新增单条
  DISTINCT-ON-fingerprint 聚合查询」**（探针是 dispatched-only bool，本面要全 status 语境，形态
  不同不是复用）。
- **「从未派」软化为「无派发记录」**：`dispatchSupplyTarget` 的 `writeEvent` 是 try/catch 自限
  （§1.2），**真派过但事件写失败**会造成「有派发无凭证」态——故 `lastActivity===null` 只能诚实说
  「无派发记录」，不能断言「从未派」。

**为什么是可见性不是智能**：owner 看到一个缺口，第一反应是「为啥没被补？」——注记直接回答
「3 天前派过，cooldown 到 07-11」或「无派发记录」。这**正是教研蓝图的价值**，纯只读派生，
不改 cooldown、不加决策逻辑。成本 = **一个**索引查询。（红线校对：接入注记 ✅ 只读只读；绝不据它
改 cooldown / 改优先级。）

**should#1 — confusable 事件不进本蓝图（不是缺陷，措辞澄清）**：`confusable_contrast` gapKind 由
**独立** `confusable-contrast-discovery.ts` 产出（target-discovery.ts:102-106 明注 **NOT
scanCoverageGaps**——它扫误区网不扫单-KC 覆盖池），派**同一** `experimental:question_supply` 事件
但**不在本蓝图的 KC 池维度里**。故本面按 fingerprint join 时，confusable 事件的 fingerprint 不匹配
本面任何 lattice gap → **正确无害地不 join**（面板拒绝「被静默丢弃当缺陷」的读法）。本蓝图只覆盖
scanCoverageGaps 的四条单-KC 池规则，措辞上别隐含把 confusable 也算进来（见 §5/§7.0 边界声明）。

---

## 5. API 形状 + 活扫描性能（开放问题 ③）——推荐 live scan，v1 不加缓存

- **路由**：`GET /api/admin/coverage-lattice`（无参），沿 `conjecture-scores.ts` / `calibration-
  maturity.ts` 读模型 → 薄 route 形态：`GET(){ return Response.json(await loadCoverageLattice(db)) }`
  + `errorResponse` 兜底。`/api/*` token 校验由组合根中间件统一施加。
- **live scan vs events-only**：侦察建议「读持久化事件而非 inline 活扫描」——**但事件只覆盖被
  派发的缺口（top-25/夜 cap，且从不含已覆盖 KC 与当前池态）**，拿它当替身会给出残缺+陈旧图，
  **违背蓝图目标**。故：**live scan 是当前蓝图的真相源；事件是补充注记（§4），非替身。**
- **should#1 边界（别隐含 completeness）**：本面「蓝图」的准确范围 = **scanCoverageGaps 的四条
  单-KC 池规则**（R1-R4），**不是**供给系统全部缺口的完整并集——`confusable_contrast`（误区网，
  独立 discovery）**不在本蓝图**（§4 should#1）。§0/§5/UI header/文件头措辞统一说「覆盖细目表覆盖
  scanCoverageGaps 四规则的 KC 池覆盖」，**别用「完整覆盖蓝图」这类隐含全量 completeness 的词**。
- **性能裁决 + MF2 refetch**：单用户 admin 面偶尔打开；但**其它四页硬编 `refetchInterval:60_000`
  （observability.tsx:261 / subjects.tsx:55），若镜像 → 留 tab 每 60s 重跑 3N-5N 串行扫描（hundreds
  KC → ~1000+ 串行往返）打单 Postgres，与「偶尔打开故不缓存」自相矛盾 = bug**。**MF2 裁决：本页
  useQuery 不设 `refetchInterval` + 顶部「重新扫描」按钮（owner 主动刷）**，文件头写明刻意背离 60s
  轮询范式的理由——这样「v1 不加缓存」才诚实成立。（备选：若未来坚持 auto-refetch，则 §5 TTL 缓存
  从「可选」升为**必须**，window ≥ refetch 间隔。v1 不走此路。）
- **should#6 scan_ms 遥测**：读模型用 `Date.now()` 包 `assembleScanInput`，`scan_ms` 与
  `generated_at` 并列返回——诚实披露实测耗时 + 补 `question_supply_nightly` 从不计时的缺失遥测，
  成为「TTL 到底需不需要」的**实测依据**（v1 先量再说，不预先建 TTL）。
- **不在本单做**：把 `loadFrontierKnowledge` 串行循环改 `Promise.all` 批量化——它动共享发现引擎、
  有行为变更风险、属 perf follow-up 非本 ticket（§11 记 Linear 候选）。

---

## 6. 壳矛盾收口 note（开放问题 ⑤）——落点 + 措辞

**落点**：本设计 doc 本节（一段，非 ADR 巨作）+ 同步 `observability/AGENTS.md`（四页→五页时补
一句）。新 `coverage-lattice.tsx` 文件头引本节，**不再复制** `observability.tsx`/`subjects.tsx`
那段陈旧「separate shell」措辞。

**决策记录（补录 owner 已拍之事）**：
> **admin/observability 页套主 app chrome（`RootShell`），非独立壳。** loom 设计源
> `app.jsx:146`「admin is a separate shell — no main app chrome」是**原型产物**，已被 SPA 收束为
> 单一 `RootShell`（`router.tsx` 里每条路由皆 `rootRoute` 之子，无独立 AdminShell）所**取代**；
> `AGENTS.md` 与 `router.tsx:440-442` 已反映此现实。据此，**`visual-gap.md` 决策点③（SPA 收编主
> chrome 时 admin 套不套）在此判定为「套主 chrome」，正式收口**。附勘误：audit 引的
> `app.jsx:106-114` 有引用漂移，承重裁决在 `:146` 的 `base==="admin"` early-return 注释。
> YUK-579 覆盖细目页遵 shipped 现实（`rootRoute` 之子 → `RootShell`），与既有四个 admin 页一致。

（侦察子代理曾据设计源建议「渲进独立 admin 壳」——**该建议基于已被取代的设计裁决，本单不采纳**，
遵 owner 决策 #3 + shipped 现实。）

**should#4 —— 「正式收口」名实对齐（就地替换陈旧文件头）**：`observability.tsx:5-10` +
`subjects.tsx:24-30` 两处陈旧「Phase-deferred 壳形态决策点… admin is a separate shell」文件头
（引 `app.jsx:106-114`）仍在，而这两文件**已在 §8 修改列**（要加 coverage 导航链接）。故本单
**就地把这两段文件头替换成一行指向本 §6 决策 / `AGENTS.md` 的收口注**（近零成本，顺手做）——
否则「正式收口」名实不符（决策记了但代码里还留着相反陈述）。既然要就地替换，§6 保持「正式收口」
级别（不降级为 §11 follow-up）。

---

## 7. UI 结构（开放问题 ⑥）——朴素分组只读 table

**§7.0 边界声明（should#1）**：page header sub / 文件头须写明——本面覆盖 **scanCoverageGaps 四条
单-KC 池规则的 KC 池覆盖**，非供给系统全部缺口的完整并集（`confusable_contrast` 误区网缺口不在此）。

**分组折叠顺序**：subject（section 标题）→ KC（行）→ 缺口 targets（KC 行下嵌套明细）。谁是谁：
- **行 = KC**；**列 = 池级判词**（depth / src / diag / fmt / θ̂ / ev / #gaps）；
- **四维点阵的 kind×band×tier 三轴 = 嵌套缺口明细行的 desired 坐标**（非矩阵，不撒谎逐格覆盖）；
- **折叠维 = subject section**（+ 可选 KC 明细展开）。

**MF2 —— 无 auto-refetch + 「重新扫描」按钮**：page header 右侧放一个 `Button icon="refresh"`
「重新扫描」（`invalidateQueries` 手动刷）；useQuery **不设 `refetchInterval`**。文件头写明刻意
背离四页 60s 轮询范式（避免每 60s 重跑 3N-5N 串行扫描）。

**MF3 —— 渲染规范收紧（把「不撒谎逐格覆盖」编码进 artifact，非只留散文）**：
1. **desired 坐标禁止 column-aligned 成矩阵**——每条嵌套坐标渲成**从属其触发规则的获取请求**：
   `wants: <kind>/<band>/tier<N> ×<count>`（自然语言 label，不是对齐成看似被扫过的格子行）。
2. **`frontier_zero` 的 band/tier 是硬编脚手架常量**（target-discovery.ts:388-394：kind='any' /
   band='near' / minSourceTier=2），对零池 KC **无 per-KC 扫描依据**（line 401 短路）却不能渲得
   像被扫过 → **置灰 + 标 `default scaffold, not scanned`**（或省略坐标只留 gapKind + count）。
3. **未评估轴渲成显式 chip** `未评估·空池`（`Badge tone="neutral"`），**不是**裸 `n/a` / `·`——
   让「无数据」在 artifact 层就自证，不靠读者读散文。

```
Coverage Lattice                            [ADMIN · question supply]  [↻ 重新扫描]
覆盖 scanCoverageGaps 四规则的 KC 池覆盖 · 非全量缺口并集(confusable 另计)
generated 07-07 15:40 · scan 840ms · 3 subjects · 42 active KCs · 11 with gaps
[ runs ] [ cost ] [ failures ] [ subjects ] [ coverage ]     ← 5 页横向导航

┌─ wenyan (文言文) ───────────────────────────────────────────────────┐
│ KC                depth  src   diag  fmt   θ̂     ev   gaps          │
│ kn_xu (虚词·之)    2/2    ✓     ✓     ✓    0.30   5    —             │
│ kn_shi (使动)      1/2    gap   gap   ·   -0.10   2    2  ▸          │
│    └ [source_quality]  wants: choice/near/tier2 ×1 · p0.70          │
│         · dispatched 3d ago · cooldown→07-11                         │
│    └ [diagnostic]      wants: choice/near/tier2 ×1 · p0.70 · 无派发记录│
│ kn_huo (词类活用)  0/2  [未评估·空池]×3    0.00   0    1  ▸          │
│    └ [frontier_zero]   default scaffold (not scanned) ×2 · p1.00     │
│         · 无派发记录                                                  │
└─────────────────────────────────────────────────────────────────────┘
```
复用既有 admin 范式：`PageHeader`（title/eyebrow/sub + 导航行 children + 重新扫描 Button）+
`Stateful`（loading/error/ok）+ `Card pad="lg"` + 原生 `<table>` + inline `CSSProperties` 走
`var(--*)` tokens（镜像 `observability.tsx`/`subjects.tsx`）。gapKind / status / 未评估 用 `Badge` tone。

---

## 8. Touch 清单（Lane J 修正版）

**创建**：
- `src/capabilities/observability/server/coverage-lattice.ts`（读模型：`loadCoverageLattice(db)` +
  纯变换 + `GapActivity` 事件派生）。
- `src/capabilities/observability/api/coverage-lattice.ts`（薄 GET）。
- `src/capabilities/observability/ui/coverage-lattice.tsx`（第五面 surface）。
- `src/capabilities/observability/server/coverage-lattice.unit.test.ts`（纯变换 RED 靶）。
- `src/capabilities/observability/api/coverage-lattice.db.test.ts`（route db test）。
- `docs/design/2026-07-07-yuk579-coverage-lattice.md`（本 draft）。

**修改**：
- `src/server/question-supply/target-discovery.ts`（导出 `assembleScanInput` + 重构
  `discoverSupplyTargets` + 导出 `COVERAGE_DEPTH_THRESHOLD`；行为等价）。
- `src/capabilities/observability/manifest.ts`（`api.routes += /api/admin/coverage-lattice`；
  `ui.pages += /admin/coverage-lattice`）。
- `web/src/router.tsx`（import surface + route wrapper + `addChildren`；仅本 lane 动）。
- `src/capabilities/observability/ui/observability.tsx`（**should#5**：`AdminLinks` :241-248 补齐
  **完整五链** runs/cost/failures/**subjects**/coverage——现仅三链漏 subjects；**should#4**：替换
  :5-10 陈旧「separate shell」文件头为指向 §6/AGENTS.md 的收口注）。
- `src/capabilities/observability/ui/subjects.tsx`（**should#5**：nav :79-81 同补齐五链；
  **should#4**：替换 :24-30 陈旧「separate shell」文件头为收口注）。
- `src/capabilities/observability/AGENTS.md`（四页→五页 + §6 壳 note 一句）。
- `src/capabilities/composition.unit.test.ts`（加断言：新 route 由 observability 独家声明 +
  `ui.pages` 含 `/admin/coverage-lattice`）。
- `postman/api-endpoints.json` + 跑 `pnpm gen:postman`（新 route 同步 spec，manifest 对账层守）。

**scope 注（§8，面板 should#5 已裁决纳入）**：既有 admin 导航行只列 runs/cost/failures 三链，
**漏了 subjects**（pre-existing 不一致）。本单为第五页加 coverage 时**顺手补齐完整五链**
runs/cost/failures/subjects/coverage，**不留「加了 coverage 仍漏 subjects」的四链残态**。

---

## 9. Phase 2 计划（判词后）

1. **TDD RED 先行**：
   - `coverage-lattice.unit.test.ts`（纯变换，无 DB）：喂合成 `ScanInput` + targets + activity map
     → 断言纯变换输出。**should#2 一致性断言**：每行 `depthMet ⟺ usableCount ≥
     COVERAGE_DEPTH_THRESHOLD ⟺ frontier_zero 缺席`；且 `usableCount===0 ⟺ 三轴（hasHighTier /
     hasNearThetaAnchor / formatDiverse）皆 null`。**MF1 断言**：`inCooldown`/`cooldownUntil` 只从
     `status='dispatched'` 事件算（有 manual/skipped 但无 dispatched → `inCooldown=false`,
     `lastStatus` 仍取最新任意 status）。**MF3 断言**：frontier_zero gap 携 `scaffold:true`（或等价
     渲染标记）供 UI 置灰；未评估轴产显式标记。
   - `coverage-lattice.db.test.ts`：seed `learning_item`(active) + `question` + `item_calibration` +
     `mastery_state` + `experimental:question_supply` 事件（含 dispatched + manual 混合，验 MF1 聚合）
     → 调 `GET()` → 断言 lattice 形状 + `scan_ms` 存在 + **read-only（行数不变，ND：零写零 FSRS
     零事件）** + 空态 `[]` 不崩（镜像 `conjecture-scores.db.test.ts` 六条契约）。
   - `composition.unit.test.ts`：route 独家归属 + `ui.pages` 含新路由。
   - **should#3 回归 gate**：显式跑既有 `target-discovery` db test，确认 `assembleScanInput` 重构后
     `discoverSupplyTargets`（生产 nightly 消费者，practice/jobs/question_supply_nightly.ts:107）
     行为等价。
2. **全 gate**：`typecheck` / `lint` / `audit:schema` / `audit:partition` / `audit:profile` /
   `audit:draft-status` / `audit:draft-status-reads` / `test` / `build`。
3. **独立 Opus 对抗审查**（派子代理带 Bash，喂 PR diff）。
4. **push + PR**（标题/描述/commit 含 `YUK-579` + `Closes YUK-579`）→ **停在 PR open，绝不自 merge。**

---

## 10. 六决策（面板已裁决 —— 全部认可，mustFix 已并入）

| # | 决策 | 裁决（含 mustFix 修正） |
|---|------|---------|
| ① | 读模型：Zone A 池级行 + 缺口明细 vs Zone B 逐格矩阵 | ✅ **Zone A + 缺口明细（v1）**；Zone B census = v2（should#7 标注 = 纯 form 纪律非数据缺口）。诚实：不产逐格覆盖判词，池级布尔从 gapKind 反读，零池 KC 显式「未评估」chip（MF3） |
| ② | loader 导出：(a) 直接导出 vs (b) `assembleScanInput` 包层 | ✅ **(b)**——守零新查询子系统；should#3 标注为唯一共享生产引擎触点 + 回归 gate |
| ③ | API 数据源 + refetch | ✅ **live scan（真相源），v1 不缓存**；**MF2：不设 refetchInterval + 重新扫描按钮**；should#6 返回 `scan_ms` 作 TTL 实测依据 |
| ④ | 历史事件：v1 接入 cooldown/活动注记 | ✅ **v1 接入**；**MF1：单条 fingerprint 聚合查询**（非逐-target 探针）+ import cooldown 常量 + 删假陈述 + 软化「无派发记录」 |
| ⑤ | 壳 note 落点 | ✅ §6 一段 + `AGENTS.md` 五页补句；**should#4：就地替换两处陈旧 separate-shell 文件头**为收口注（名实对齐） |
| ⑥ | UI 分组：subject → KC 行 → 缺口嵌套明细 | ✅ 采纳（§7 ASCII）；**MF3：坐标渲成从属获取请求非矩阵、scaffold 常量置灰、未评估显式 chip** |
| 附 | 导航补齐漏掉的 subjects 链接 | ✅ **should#5：补齐完整五链**（含 subjects），不留四链残态 |

---

## 11. Out-of-scope / follow-up（不自行扩 scope，记此待落 Linear）

- **P-1（perf）**：`loadFrontierKnowledge` 串行 per-KC 循环批量化（`Promise.all` / 单查合并）——
  动共享发现引擎，属 perf follow-up，非本 ticket。若 §5 实测延迟痛 → 开 Linear。
- **P-2（一致性）**：~~既有 admin 导航行漏 `subjects` 链接~~ → **本单顺手修（should#5，见 §8）**，
  不再是 follow-up。
- **P-3（v2）**：Zone B 存量池逐格 census（kind×band×tier 描述性交叉表）= heatmap 二期。**should#7
  标注：defer 真因 = form/scope 纪律非数据缺口**——census 是 `assembleScanInput().questions` 的纯
  内存 group-by，v2 零新 IO / 零新 loader（免后人误建查询子系统，见 §2.4）。
- **红线外**：`computePriority` 痛点优先级调参（攻击轮明列为独立 follow-up，不进本单）。
