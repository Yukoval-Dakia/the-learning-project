# jyeoo 接入的选题匹配设计：知识点匹配与难度匹配

> 日期：2026-07-18
> 状态：设计稿，未实施；前置事实 = `~/jyeoo-rs` 已可用（48 单测绿，loom `SourcedQuestion` Zod 校验 10/10）
> 上游对齐：`2026-07-10-question-supply-system-architecture-research.md`（供题线 rethink：selection/supply 分层 + n=1 主动克制）；`2026-06-15-question-supply-target-discovery-architecture.md`（现行 supply/selection 分引擎架构）
> 关联：`~/jyeoo-rs/docs/DESIGN.md`（抓取侧契约 + 已知限制）

## 1. 机制 Grounding（实证，非推测）

选题链路真实现状（file:symbol 可查）：

| 层 | 符号 | 读什么 | 不读什么 |
|---|---|---|---|
| KC 选择（何时练） | `practice/server/due-list.ts:handleReviewDue()` | `material_fsrs_state.due_at` | difficulty、θ̂、knowledge_ids（过滤） |
| 题选择（练哪道） | `practice/server/variant-rotation.ts:pickProbeForKnowledge()` | `knowledge_ids @> [kid]` + 族轮换 | difficulty、FSRS、θ̂ |
| 能力估计 | `server/mastery/state.ts:updateThetaForAttempt()` | per-KC Elo `theta_hat` | —（只被供给侧消费） |
| 供给缺口 | `server/question-supply/target-discovery.ts:scanCoverageGaps()` | θ̂ + effectiveB（`item_calibration.b`）→ DifficultyBand（near = \|b−θ̂\|≤0.75） | `question.difficulty` 自报字段（R3 已删其兜底） |

**关键判词**：
- **知识点匹配已结构性解决**——题挂 `knowledge_ids`，选题按 KC 取题。
- **难度匹配不在选题侧**——learner 拿到什么练什么；难度的唯一实体化在供给侧（target-discovery 用 θ̂ 决定"池子缺什么难度的题"）。
- **`question.difficulty`（1-5 自报）唯一活跃消费者是 `difficultyToLogitB()`**：θ̂ 更新时 `item_calibration` 无行的降权弱锚。真难度信号 = `item_calibration.b`（标定收敛后接管）。
- 这正符合 07-10 rethink 的分层判词：selection 决定"现在给哪题"，supply 决定"未来窗口要维持什么证据库存"。

## 2. 设计判断

### 2.1 知识点匹配：target-driven 直挂，不走 embed 主路

供给是 target-driven 的：`target-discovery` 按 KC 缺口出 target，`dispatcher` 带 `knowledge_id`（anchorKid）派工。

- **主锚**：jyeoo_fetch handler 复用 `sourcing.ts:resolveQuestionKnowledgeIds` 的 trigger fallback——target 的 anchorKid 直接写入题 `knowledge_ids`。零 embed，零新机制。
- **辅助**：`jyeoo.knowledge_hints`（kpoints/topic 原文）仅作审计与可选 secondary match 输入。
- **明确不做**：以 `tagKnowledge()` embed 匹配为主路。jyeoo kpoints 粒度与 loom 知识树不一致，cosine 不命中即 PROPOSE 新节点，知识树会被 jyeoo 语料污染出细碎节点。

### 2.2 难度匹配：供给侧精准补带 + 标定路线

链路：`jyeoo --dg X` → `difficulty` 直传 → `difficultyToLogitB` 弱锚 → `item_calibration` 收敛 → effectiveB 接管 → DifficultyBand 分类。

**jyeoo vs Tavily 的本质优势在 R3 diagnostic**：target 要 near-θ̂ choice 题时，
`jyeoo-rs search --ct choice --dg <X> --kw <KC名>` 是**确定性筛选**；Tavily agent 只能自报难度，不可控。

**标定问题（诚实声明）**：jyeoo dg 5 级是站内相对难度（教研标注、偏高考向），与 loom logit b 尺度的映射未经验证。处理：
1. 接入初期：沿用现有 `difficultyToLogitB` 1-5 映射当弱锚——`item_calibration` 收敛后自报值影响随证据累积衰减，风险有界。
2. 收敛后一次性标定：统计 jyeoo 题各 dg 档实际答对率 vs θ̂，拟合 dg→b 偏移；有系统性偏移则修 jyeoo_fetch 映射表（**不改 `difficultyToLogitB` 本体**——那是 agent 自报的契约）。
3. 此路线符合 07-10 rethink 的 n=1 克制：难度值必须带"量尺、依据与置信度"——jyeoo dg 的量尺是 jyeoo 站内标注，我们对其置信度按弱锚处理，不包装成精确 IRT b。

### 2.3 必须声明的 gap（不属于本次接入）

**选题侧无个体化难度过滤**：即使供给侧把池子补得完美，个体 learner 仍可能拿到远超/远低于 θ̂ 的题。FSRS 管"何时练"，θ̂ 管"池子缺什么"，中间缺"为这个人选那道题"的个体化难度匹配。修它在 `variant-rotation`/`due-list` 加难度带过滤/排序——**loom 独立产品决策，不在 jyeoo 接入范围**。

## 3. 落地优先级

1. **本次接入**：`jyeoo_fetch` pg-boss handler = spawn jyeoo-rs → 逐行 Zod → anchorKid 直挂 + difficulty 直传 + 复用 `source_verify` 链；`SupplyRoute` 加 `'jyeoo_fetch'`；profile `sourceWhitelist` 加 `www.jyeoo.com`。知识点匹配即日可用。
2. **标定 follow-up（接入后 1-2 周，attempt 积累后）**：dg→b 偏移拟合。
3. **个体化难度选题（独立立项）**：选题侧 θ̂ 带过滤。

## 4. 与 07-10 rethink 的对齐检查

| rethink 判词 | 本设计的响应 |
|---|---|
| selection 与 supply 分层 | 难度匹配放供给侧（target-driven 补带），不给选题侧加过滤 |
| 需求是证据目标 | anchorKid 来自 target-discovery 的缺口扫描，非拍脑袋关键词 |
| 库存按题族计量 | jyeoo `extraction_hash` 供 dedup；题族治理由 supply 侧既有机械负责 |
| n=1 主动克制 | dg→b 标定按弱锚+后验拟合，不虚构精确难度 |
| 质量非单一 source tier | jyeoo 题走 `source='web_sourced'` + tier 2 + `source_verify` 全检，不豁免 |

## 5. 实证附录（2026-07-18 终审：VIP、抽稀实测、ID 漂移）

接入前置实测（账号 173…6385，math2，2 题 × 多响应 + Playwright 对照）：

1. **VIP 是 jyeoo_fetch 的硬前置**。非 VIP 响应的 analysis/solution/comment 被服务端
   按响应随机抽稀（实测 ~5-20%/字段，数学记号/运算符同样被抽——解答是**语义级错误**
   而非单纯残缺）；浏览器端无 JS 补全（jye.min.js 无此逻辑）；充 VIP（¥59/月档）后
   服务端直出完整字段，同题两次抓取逐字节一致。**handler 契约**：cookie 必须是 VIP
   账号；每次运行检测详情页模板 `var vip = 'False' == 'True'`，命中即整体失败退出
   （VIP 过期 = 静默降级为有洞 reference_md，不得入库）。
2. **source_verify 链安全，但仅限入库当下**。extract 锚 = stem+answer，非 VIP 也不抽
   （2 题 × 3 响应零缺失），overlap 校验不受抽稀影响。现有 source_verify 只读持久化
   extract、不重抓 URL——在 ID 漂移（见下）下这一点恰好是必需的，**不得**给 jyeoo 题
   加"按 source_url 重抓复核"的后验步骤。
3. **ID 漂移 ⇒ dedup 只能靠内容指纹，位置 = forager 录入预筛（既有设计）**。同一 detail ID 数小时后映射到同考卷另一道题（源前缀不变、题变，疑密钥按天轮换），URL/ID 均不可用于 dedup。dedup 的设计已有定论——`matcher-form-spec`（2026-06-17）§3.1/§5：不另立 raw 池表（`question` draft 切片即 raw 池），**fingerprint 去重 = forager 录入侧廉价确定性预筛（n-gram/embedding，复用 `maxNgramOverlap` + Phase 0 pgvector 底座，无 LLM，INSERT 前，against active+draft 池）**；forager 本体是 Phase 1 后段增量（YUK-397 链，未建）。现状：`sourcing.ts` INSERT 路径逐题 `createId()` 直插；`extraction_hash` 落 `metadata.web_sourced` 但零读取方（YUK-216 定位"去重/审计旁证"，体系里只是旁证）；`maxNgramOverlap`（quiz_verify.ts:157）与 `poolFetch`（activeOnly:false 可查 draft 切片）是现成可复用件。jyeoo_fetch 就是确定性 forager（囤料→预筛→draft 池→source_verify 链），预筛按 §5 形态落地：**第一道 extraction_hash 精确查重（零成本，VIP 后内容稳定）；第二道 maxNgramOverlap 近重查重（抓 hash 抖动的变体）**。这是对 §3"复用 sourcing.ts INSERT 路径"的增量要求，也是 forager 预筛的第一个实现实例。
   真题复验（同日晚，YUK-677 追评）：42 题实抓 + 3 题重抓——同题正对 0.0000，42 题内 861 对与跨池 2604 对在 t=0.06 下**零误判**；0.084 处存在"同风格不同题"，仲裁区设计必需。**图象题复核（修正早先"图干题"表述）**：42 题中 0 纯图干，6/42 图文混排（"图象如图所示"型，图携带解题关键信息，已实测一张为抛物线零点图）。处理：①embed 前剥离 `![…](…)` 图片 markdown——共享 URL 样板把图象题互相拉近（0.158-0.193），污染仲裁区人口；②图象依赖题**不需改表**——`question.figures`/`image_refs` 一等多模态载体列已在（M-1，2026-05-21；FigureRef: asset_id + role='diagram' + attached_to_index 指向 structured/stem id），且 judge routing 对带图题自动走 `multimodal_direct`。jyeoo_fetch 的 glue = `--images` 下载 → R2 + source_asset 行 → 写 `question.figures`（bbox 用全帧、attach 到 stem）+ prompt_md 图引用改写为 `/api/assets/<id>/content`；或抓取期过滤，否则判分缺关键信息。
4. **jyeoo-rs cache 需 TTL**。`.cache/{ques_id}.json` 命中即跳过，ID 漂移后旧题顶包；
   接入侧要求 jyeoo-rs cache 加 24h TTL（或改按 extraction_hash 存）。
5. **配额/次数不构成抓取约束**。非 VIP 每日浏览配额经浏览器 JS 跳 phbcuenavi 计数，
   静态抓取不触发；VIP 的 20 次/月是下载次数（导出文件），题页抓取不消耗。
