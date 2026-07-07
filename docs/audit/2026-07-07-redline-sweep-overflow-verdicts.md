# 红线挑战审查 · sweep 溢出 2 条收口裁决（2026-07-07）

> **性质**：`docs/audit/2026-07-07-redline-challenge-audit.md` §6 覆盖披露记录的 2 条
> 「未审（下轮可补）」簇的收口裁决。独立成文（不改主审文档，避免与在飞条文波 PR 冲突）。
>
> **方法披露**：主审 16+6 簇走的是 challenger/defense/终裁分席的多 agent 环；本收口由
> Fable 单脑完成（挑战、辩护、终裁同席、分步成文，全部主张现场 code-ground），按终审
> doctrine D8（收尾综合收回单脑）执行——诚实标注方法差异，供复审时校准信任度。
> 全部 file:line 锚点为 2026-07-07 @main 快照，随 main 前进会漂移。

---

## C-23 · `kg-mesh-no-tree-expressed-edge`（mesh 不存 tree 已表达的边）

### 条文与出处

- ADR-0011 §Mesh 不变量：「propose 时若 `from→to` 已是 tree parent_id 关系，agent 应拒绝
  （"mesh 不存 tree 已表达的边"）。这条 invariant 在 propose handler 前置 guard 里强制」
  （`docs/adr/0011-tool-use-and-edge-event-paths.md:173`）；同文 :290 预留升级路径
  （「若代码 guard 后仍有 leak，考虑 PG check constraint」）。
- ADR-0010（knowledge mesh）经 `docs/planning/v0.4-complete-form-roadmap.md:101` 锁定，
  invariant 列入锁定后果；`docs/superpowers/specs/2026-06-10-functional-goal-map.md:222`
  第 6 条复述（「树是骨架，网是肌肉……mesh edge 不存树已表达的边」）。

### 起源考古

**Design-born + owner 亲拍**：`docs/design/loom-design-v2.1/chats/chat1.md:538` 实录
「§2.1 mesh 去镜像——我之前 push back 的『mesh 不存 tree 已表达的边』被采纳；
KNOWLEDGE_EDGES 重写不含 `derived_from → parent_id`」。这是设计对话里被明确挑战过
一次并胜出的条款，非舶来默认。

### Code-ground（2026-07-07 @ main）

1. **强制点存在且现行**：`src/capabilities/knowledge/server/rubric-validator.ts` G6
   `parent_semantic_duplicate` 闸（`restatesTreeAncestry`，双向祖先链、深度 cap 32），
   跑在全部 agent 提案路径（`propose_edge.ts:382` / `review.ts:438` /
   `proposal-tools.ts`）且对 user-edited 提案同样生效（§4.1 结构类）。
   2026-05-17 drift 审计曾抓到「未在 propose handler 强制」（`docs/audit/2026-05-17-drift.md:25`），
   P5.4 落 G6 后该缺口已闭合。
2. **现行形态 ≠ 条文字面，双向偏离**：
   - **比条文宽**：条文说「tree parent_id 关系」（直接父子）；G6 走 32 层祖先链
     （ancestor/descendant 全链 restate 都拒）。
   - **比条文窄**：G6 只对 `related_to` / `derived_from` 生效；`prerequisite` /
     `applied_in` / `contrasts_with` **刻意豁免**（rubric-validator.ts:489-495：§3.3
     明示 hierarchy-aligned prerequisite〔父概念→子任务〕与 applied_in〔概念→应用〕
     恰恰因一端是另一端祖先而合法，语义检查由各自 §4.3 关系闸承担）。
3. **Leak 面坐实但受限**：直写路径 `createKnowledgeEdge`
   （`src/capabilities/knowledge/server/edges.ts`，POST /api/edges，actor 默认
   `{user, self}`）只跑 ADR-0034 拓扑闸（self-loop / cycle / 方向矛盾 / 传递冗余），
   **不跑 G6**——ADR-0011:290 预言的 leak 至今成立。但该 lane 的写入者只有 owner 本人
   （agent 边一律走 propose；reconcile 走同咽喉但只做 SUPERSEDE 语义）。

### 挑战（steelman）

1. **冗余有用论**：mesh-only 消费者（图算法、邻接检索）读不到 tree 表达的层级关系，
   存冗余边可让 mesh 自足。
2. **豁免掏空论**：G6 只管两种关系，五种里三种可以合法「重述」树——条文字面
   （无条件禁）已经名存实亡，该 RELAX 成文。
3. **散文不承重论**：条文声称「在 propose handler 前置 guard 强制」曾被 drift 审计
   证伪一次，直写 lane 至今不设防——执行史削弱条文权威。

### 辩护

1. **无 mesh-only-blind 消费者**：实测消费面全部 tree+mesh 组合读——hub-mesh 策展
   rule i/ii 直接走树（`hub-mesh.ts` `treeDescendantIds` BFS）再叠 mesh rule iii；
   paths / overview 类 reader 同构。冗余边不解决任何现存消费者的问题，只引入
   双写者漂移（tree 改父子后 mesh 冗余边成为无人负责的陈旧副本）——恰是本项目
   头号病（成文-现实分裂）在数据层的同构体。
2. **豁免是条文自身语义的正确展开，不是掏空**：条文的完整表述含「with no new
   semantics」限定（G6 注释与 §4.3 均记录）。parent→child 的 `prerequisite` 边携带
   **学习顺序**语义、`applied_in` 携带**应用场景**语义，都不是对「包含关系」的
   restate；真正只能 restate 层级的两种关系（related_to / derived_from）恰好就是
   G6 的作用域。豁免清单每条带成文理由（§3.3），非侵蚀。
3. **执行史反而支持 KEEP**：drift 审计抓到缺口 → P5.4 闭合，是「审计-修复」环
   工作正常的证据；残留的直写 lane 属 owner 亲手通道——owner 对自己图谱的覆写权
   与 X1 的载体判据一致（owner 亲自动作不受 agent 纪律约束），记为已知豁免而非缺陷。

### 终裁：**KEEP-WITH-COST**（条文承重；勘误 + 两条 COST 注记）

- **勘误**（挂 redline 菜单批③勘误通道，与 A3 同式）：ADR-0011 §Mesh 不变量措辞
  落后于现行 G6 形态——应注记 (a) 作用域 = related_to / derived_from（其余三关系
  由 §4.3 语义闸接管，理由 §3.3）；(b) 深度 = 祖先链非仅直接父子；(c) 强制点 =
  rubric G6 非 propose handler 前置 guard。这是横切 #1（成文-现实分裂）的又一实例，
  且是「代码比条文更对」的方向——修文不修码。
- **COST-1**：直写 lane（POST /api/edges）不跑 G6 = 已知豁免，成立前提是「该 lane
  写入者只有 owner」。**若未来任何 agent 获得直写 edge 通道（绕 propose），G6 必须
  同步前置**——此触发器句应随勘误进 ADR-0011。
- **COST-2**：条文在 4 份文档重复成文（ADR-0010 锁定件 / ADR-0011 / functional-goal-map
  / v0.4 roadmap），勘误须四处同步或指定单一权威（建议 ADR-0011 为准、余者改指针）。

---

## C-24 · `credit-decay-weight-vs-encompassing-weight-separation`（credit 衰减只用 encompassing_weight，weight 钉死 confidence-only）

### 条文与出处

ADR-0036（双层异构 KG）决定⑥ + RT2 段
（`docs/adr/0036-dual-layer-heterogeneous-knowledge-graph.md:32-33`）：credit 沿
prerequisite 反向遍历、**只乘 `encompassing_weight` 连乘衰减**；`weight` 钉死
confidence-only，只作边的 inclusion 阈值/门控，**绝不当 credit 衰减系数**；显式禁
`weight × encompassing_weight`。

### 起源考古

**Review-born（近失事故驱动，非纯理论）**：前身文档
`docs/design/2026-06-14-product-rethink-phase1_5-relations.md:70` 的原稿正是
「weight×encompassing_weight 连乘衰减」；ADR-0036:33 自述「修 review 发现的语义混用」
——条文诞生自一次被评审当场拦下的真实混用，语义论证当时就写完整（「confidence 决定
信不信这条边，encompassing_weight 决定信了之后 trickle 多少」）。

### Code-ground（2026-07-07 @ main）

- `encompassing_weight` 列在 `src/db/schema.ts` **不存在**（全 src 零命中）；RT2 层级
  credit 传播零实现、零消费者。**本条是纯 doctrine 红线，dark**——比 X5（theory-born
  但有 shadow 面）更空：连采集面都没有。
- 唯一相关活代码 = `knowledge_edge.weight` 的 confidence-only 消费（inclusion 门控类
  读点），与条文一致。
- ⚠️ 前身文档 phase1_5-relations.md:70 的**旧稿（连乘版）仍在库中原文可读**，未标
  superseded——未来实现者若以它为指引会精确复现被 ADR 拦下的混用。

### 挑战（steelman）

1. **贝叶斯期望论（最强挑战）**：E[credit] = P(边为真) × 传递分数——把 confidence
   乘进去恰是决策论正确的期望加权；硬门槛把连续置信二值化 = 丢信息 + 阈值悬崖效应
   （0.49 的边零贡献、0.51 的边全额贡献）。
2. **死条文论**：零实现零消费零机器强制，RETIRE 待 RT2 立项时再议，减登记面。

### 辩护

1. **期望论的前提被 X5 红线显式否定**：期望加权在「confidence 已校准」时才是正确的
   ——而本仓库的 `weight` 是未校准 LLM 输出，X5（未校准置信度 shadow-only，主审
   KEEP）禁止它以数值身份进入任何 mastery 邻层计算。乘法通道 = 给未校准数字开进
   结算派生层的直通道；粗粒度门控对 miscalibration 更稳健，且保持 credit 可审计
   （衰减系数全部来自单一语义列）。悬崖效应真实存在，但它是「低置信边整条不参与」
   的显式可解释行为，好过被错误标定的连续系数静默扭曲每一条 credit。**若未来
   weight 获得校准腿（X5 翻转），本条是第一批应重开的条文**——该触发器句应预写进
   ADR。
2. **RETIRE 恰好制造定时炸弹**：条文的价值在实现**之前**锁定语义——删掉它之后，
   库中唯一在案的实现指引就是 phase1_5:70 的连乘旧稿（见 code-ground ⚠️），RT2
   落地时大概率按旧稿实现、精确复现被拦的混用。「双语义列」是本仓库已付过学费的
   病（ADR-0036 自己就是修 weight 语义混用的产物；misconception weight 的 DISPLAY
   投影注释同款）。dark doctrine 的维护成本 ≈ 0（一段 ADR 文字），期望损失 > 成本。

### 终裁：**KEEP**（条文一字不动；三条 COST 注记）

- **COST-1（机器强制预埋）**：RT2 落地 PR 必须带「credit 计算路径不引用 `weight`」的
  直测 + marker（机检可行：credit 函数体对 `weight` 的引用是 grep 级判据）——把本条
  从散文升级为测试，恰在它第一次可能被违反的时刻。此要求应作为 RT2 的成文前置写进
  ADR-0036。
- **COST-2（防复审复挑）**：贝叶斯期望挑战 + X5 前提答复 + 「校准腿出现即重开」触发器
  收进 ADR-0036 注记，防下轮审查重打同一拳。
- **COST-3（拆弹）**：phase1_5-relations.md:70 连乘旧稿加一行 superseded 指针
  （→ ADR-0036 决定⑥），消除双指引。

---

## 收口状态

- 主审 §6 的「2 条未审」至此全部收口：**C-23 = KEEP-WITH-COST（勘误 + 2 COST）·
  C-24 = KEEP（3 COST）**，与主审总格局一致（条文本体承重，病在成文-现实对齐层）。
- 全部落点为改文类（ADR-0011 勘误 / ADR-0036 注记 / phase1_5 指针），属 owner 拍板
  通道，随 redline 菜单批③既有勘误项走，**不开新 Linear 单**；两条的 COST 触发器
  （agent 直写 edge 通道出现 / weight 校准腿出现 / RT2 立项）各自钉死重开时机。
