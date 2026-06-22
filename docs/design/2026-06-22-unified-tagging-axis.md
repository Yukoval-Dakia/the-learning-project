# 统一 match-or-propose KC 标注（tagging 轴重设计 + cold-start-bridge 解体）

> 2026-06-22 · owner-directed design。标注（KC 归属）轴。**与 YUK-488（整页 holistic vision 判分 / performance 轴）正交** —— 本设计只决定「一道题的**内容**该归到哪个 KC，或该不该建新 KC」，不碰学生作答判分。
>
> 本 doc 是 repo 源、Linear 为镜像（见 `feedback_docs_sync_to_linear`）。grounding 由 `unified-tagging-design-grounding` workflow（4 路存活探针 + spot-check）坐实。

## 0. 缘起 / 死耦合考古

标注轴今天「每入口各搞一套」，要收敛成**一个统一的 match-or-propose 任务**，跑在所有题目创建入口。

**YUK-478 的前提是错的**（`cold-start-bridge.ts:7-8` 注释逐字）：「thin-seed 树只有 subject-root → TaggingTask 反幻觉 filter 丢弃所有建议 → `knowledge_ids:[]` → 题目对 placement 不可见」。这不成立：反幻觉 filter 丢的是「不在网格里的 id」，而 subject-root **就在网格里**，tagger **会匹配 root**（实测：种 root 后题经 `route='auto'` 挂 `seed:math:root`）。所以「零匹配」窗口被 root 永久关死 → cold-start-bridge 近乎死代码。

cold-start-bridge **整体解体**：
- **① subject→子 KC** 半截 → **融进**本统一任务（embedding 检索驱动 match-or-propose）。
- **③ reference-answer** 半截 → **解耦**，改由「OCR 抽到题面但没抽到答案（`reference_md===null`）」触发，独立于 KC（它是判分锚点 concern，喂 `route-resolve.ts`，不该与 KC 匹配同生共死）。
- 死的 `knowledge_ids:[]` 零匹配门**移除** —— 任务自己 per-question 决定 match vs propose，`propose` 永远产出一个具体 KC id（auto-approve），不存在「空→不可见」失效模式。

## 1. owner 决策（已拍板，不重议）

1. match-vs-propose 由 **embedding 语义检索相似度**（KC embedding + 阈值）驱动，属规划中的 KC/题库语义检索。
2. KC dedup/merge **异步跑在维护 lane**。
3. 新 KC **自动批准**（+ audit trail），异步 consolidation 兜底。
4. 统一标注跑在**所有题目创建入口**（auto-enroll/上传、手动 `/api/mistakes`、import、image-candidate-accept/web-sourcing），不只 auto-enroll。

## 2. 现状：live vs dormant（诚实地基）

> 真实成本 = 下表「partial/dormant/absent」行要复活/新建的东西。

| 组件 | 状态 | 证据 |
|---|---|---|
| **维护 lane** | **live** | `knowledge_maintenance_nightly`（`0 3 * * *` 上海，agent tier）`knowledge/manifest.ts`；跑 `KnowledgeReviewTask`；registrar boot 时 mount+schedule。但 dedup 今天是 LLM agent 在宽泛 review 里**顺带建议**，非专用检测器。 |
| **dreaming** | **live** | `dreaming_nightly`（`15 3 * * *` 上海）`agency/manifest.ts`；无条件跑、proposal-only、`experimental:dreaming_scan` 留痕。非 tagging 轴，只 additively 偏置提议。 |
| **KC embedding** | **live(算) / dormant(读)** | `knowledge.embedding vector(1024)` nightly `embed_backfill`（DashScope `text-embedding-v4`）刷新；reparent NULL 触发重嵌。**但零 `<=>` 读取消费者**（spot-check 确认唯一消费者是 `embed_backfill.ts` 写侧）。 |
| **错因(cause) embedding** | **absent** | `misconception` 表显式不含 embedding；cause 走 `mistake_variant.cause_category` 纯 text 精确枚举匹配。**本设计范围外**（tagging 只需 KC + question）。 |
| **question embedding** | **live(算) / dormant(读)** | `question.embedding vector(1024)` 同 nightly backfill；编辑重嵌 live。读路径 `poolFetch` cosine 存在，但唯一活调用方 scalar-only。 |
| **语义检索** | **partial —— question 侧有、knowledge 侧无** | 唯一 pgvector `<=>` SQL 在 `pool-fetch.ts` over **`question`**，且唯一非测试调用方不传 queryEmbedding（scalar）。**KC 侧检索器不存在**；`poolFetch` 的 ORDER-BY-cosine 是可复用**模板**、非可复用代码（查的是错的表）。 |
| **matcher** | **dormant + 错轴** | `matcher()`（`src/server/quiz/matcher.ts`，`MATCHER_COSINE_MAX_DISTANCE=0.35`）已建但**无 live 调用方**（`matcher-flags.ts` 自注「no live production caller yet」）。且 I/O 是 `Demand{knowledgeId}→{used:questions[],residual}` —— 匹配**题→KC（供给）**，非**内容→候选 KC（标注）**。**不复用**，只借阈值保守 pattern。 |

**成本读出**：KC/question 向量**已算、新鲜**（唯一贵的事已做）。**净新建**：(a) KC 余弦检索器 `matchKnowledgeBySimilarity`（无等价物），(b) 统一标注步 + match-vs-propose 决策，(c) tag 时 query-side embed，(d) 维护 lane 上专用 dedup 检测信号。**复活/接线**：维护 lane *已活*，只缺重复检测信号喂入 + 可观测。matcher **不复用**（错形状）。

## 3. 统一任务 —— `TaggingTask`（match-or-propose）

题目创建路径上的共享步，替换今天的「auto-enroll LLM-prefill knowledge_ids + 落 `applyProposeNew`」与 cold-start-bridge ①。

### I/O 契约

```
INPUT
  question_text     : string         // 抽取题面（+ 可选 reference / choices）
  knowledge_hint?   : string | null  // 抽取期软提示（非权威）
  subject_root_id   : string         // 解析出的科目 root（seed:<subjectId>:root）
  candidate_kcs     : Array<{ knowledge_id, name, effective_domain, cosine_sim }>
                                      // 由 embedding 相似度检索（见 flow）

OUTPUT（判别式 union —— 任务 per-question 决定）
  | { kind:'match',   knowledge_ids: string[] }                      // ≥1 已有 KC
  | { kind:'propose', kc_name: string(≤60), parent_subject_root_id } // 新 KC
```

输出本身就是 match-vs-propose 裁决。`propose` 永远产出具体 KC id（auto-approve），**死的零匹配门移除**。

### Flow：embedding 检索 → match-or-propose

```
1. embed query        embedText(questionEmbedText(question)) → qvec(1024, DashScope v4)
                      （复用 embed-source.ts；query-side embed 是新接线 —— backfill 只嵌行）
2. retrieve           matchKnowledgeBySimilarity(db, qvec, {subjectScope?, topK})
                      → ORDER BY knowledge.embedding <=> qvec，排除 NULL-embedding 行
                      （新建：poolFetch 模式从 question 改瞄 knowledge）
3. decide             top 候选 cosine_sim ≥ MATCH_THRESHOLD ?
                        YES → kind:'match'，knowledge_ids=[所有 ≥ 阈值的候选]
                        NO  → kind:'propose'，kc_name（LLM 据内容+hint 命名），parent=subject_root
4. (可选 LLM 仲裁)     候选模糊/边界时，一次 LLM pass over {question, 候选名+domain} 确认/精修
                      match 或 proposed name。便宜路 = 纯阈值；LLM 只管灰带。
```

### `MATCH_THRESHOLD` 旋钮
单个 cosine 相似度下限（镜像 matcher 的 0.35 距离 ≈ sim≥0.65，当前**未标定**，关联 YUK-396）。放进 `tagging-flags.ts`（matcher-flags.ts 模式）可调/dark-ship。**薄树上保守默认偏 propose**（冷启正确 —— 太急 match 会误归到唯一可用的 root）；树长大后阈值收紧偏复用。

### 接入点（共享步，所有入口）

| 入口 | 今天 | 之后 |
|---|---|---|
| auto-enroll / 上传 | `verdict.prefilled.knowledge_ids` 否则 bridge①（`auto-enroll.ts:535,552`） | 调共享 `tagKnowledge` |
| image-candidate-accept | bridge①（`image-candidate-accept.ts:631`） | 调共享 `tagKnowledge` |
| 手动 `/api/mistakes` | 路由收到的 ids | 调共享 `tagKnowledge` |
| import `/api/import` | content-driven note（`import.ts:470`） | 调共享 `tagKnowledge` |

LLM 调用跑在 **DB tx 外**（保留 `runColdStartBridgeFn` seam：tag 裁决传**进** enroll tx，绝不在 tx 内调模型）。

### auto-approve + audit 写入（复用 live 原语）
新 KC **自动批准**、非 pending proposal。机制 **today 已活**（`auto-enroll.ts:711-730`）：
- `applyProposeNew(tx, {mutation:'propose_new', name, parent_id})` → 立即返回 live `knowledge_id`。
- audit-only provenance：写一条**带独特 action 的 plain event**（今 `experimental:cold_start_kc_created`；泛化为 `experimental:auto_tag_kc_created`）。`proposalWhere()`（`inbox.ts:176-187`）**不**把泛型 `experimental:*` 折进 inbox → 可查可审、但永不是 pending inbox 项、无 acceptProposal 路径、不可重放。= 已被代码验证的「auto-approve-with-audit」。

### ref-answer 解耦（bridge ③ 半截剥离）
bridge 今天把 ①+③ 捆一个 LLM pass。重设计后 ③ 成独立小任务，触发 = **`existing_reference_md===null`**（OCR 抽到题面没抽到答案），与 KC 无关；有答案则 echo verbatim / no-op。

## 4. dedup-on-maintenance 兜底环

auto-approve 必然攒近重复 KC（薄树上两次同主题上传、在任一被嵌入前都会各 propose）。维护 lane 是兜底。

**lane 要先复活吗？不用 —— 已活且 scheduled。** `knowledge_maintenance_nightly` nightly 跑；`KnowledgeReviewTask` 的 `write_proposal` 工具已枚举 `merge`；accept-applier `acceptProposal→applyMerge`（`proposals.ts:586-593`，version-guard）全接线，经 `POST /api/knowledge/proposals/[id]` 可达。**缺的不是 infra，是重复检测信号** —— 今天靠 LLM agent 在全树上自发注意到重复（很少发生）+ 无可观测。（owner「好久没听到」的直觉 = 追到 **stale doc `lanes.md`** 把 merge 误标「Phase 2+」，而非代码。）

**两个实现选项，从轻起、需要再升级：**
- **最轻（扩现有 job，无新 infra）**：给 `KnowledgeReviewTask` 喂一份**预算好的近重复候选表** —— 对近 N 天带 `experimental:auto_tag_kc_created` 的新 KC 做 pairwise `knowledge.embedding <=>` 余弦、阈值化。agent 对确认的重复出 `merge` 提议；现成 `applyMerge` 在 accept 时落地。= 对 live 向量做读 + 改 prompt 输入。
- **专用（新确定性 job）**：加 `kc_dedup_nightly` JobDecl 到 `knowledge/manifest.ts`（registrar 自动 mount+schedule），确定性余弦扫描、经 `writeKnowledgeProposeEvent` 出 merge 提议。更可观测、归属更清，但更多代码。

**铁律保留**：dedup **propose-only，非 auto-merge**。auto-**approve** 用于*创建* KC（便宜、加性、可经 merge 回滚）；auto-**merge** 两个 KC 是破坏性（重写 `knowledge_ids` 归属、置 `merged_from[]`），仍走人工 accept UI。**建得急、并得慎。**

**批内一致（tag 时杀重复于摇篮）**：一次上传常有同主题兄弟题。各自独立 tag → N 个都 propose 同一新 KC → N 个重复要 lane 夜里并。**整次上传一遍 tag**：`tagKnowledge` 内维护**会话内 proposed-KC 缓存** —— 题1 propose `kc_name=X`@root 得 `k1` 后，题2..N 从 in-pass 缓存命中 `k1`（名+root，或对刚建向量重嵌-match）而 *match* 它、不重 propose。auto-enroll 已逐题处理上传，缓存即穿过循环的 per-run map。

## 5. Build sequence + 依赖排序

**阻塞关系**：KC 向量 live（substrate 就绪，非阻塞）· KC 语义检索 absent → `matchKnowledgeBySimilarity` 净新、在关键路径 · matcher dormant+错轴 → **非依赖、别等/别接** · 维护 lane live → dedup 环不阻塞 infra、只缺候选信号 · auto-approve 原语 live → propose 半截不阻塞。

**关键路径**：
```
embed-source.ts(live)            applyProposeNew+audit(live)
       │                                 │
       ▼                                 ▼
[P1] matchKnowledgeBySimilarity ─► [P2] TaggingTask(match-or-propose) ─► [P3] 接 4 入口(共享 tagKnowledge)
   (KC 余弦检索器，净新)              + MATCH_THRESHOLD + 批内一致缓存
                                     + auto-approve 写(复用 live)
                                                                         ├─ [P4a] ref-answer 解耦(并行)
                                                                         └─ [P5]  dedup-on-maintenance(喂信号)
```

**Ship 顺序**：
1. **P1 `matchKnowledgeBySimilarity`**（KC 余弦检索器，retarget `pool-fetch.ts` 的 `<=>` 模式从 question 到 knowledge）。**match 半截的闸。**
2. **P2 `TaggingTask`**（union 输出 + `MATCH_THRESHOLD` + 批内一致缓存 + auto-approve 写，复用 live 原语）。可对 P1 用 stub 检索器先建测试。
3. **P3 接共享 `tagKnowledge` 进 4 入口**，删死的零匹配门。**这一步让 tagging 统一 + live。**
4. **P4a ref-answer 解耦**（独立、可与 P3 并行）：bridge③ 拆成 `reference_md===null` 触发。小、无 P1/P2 依赖。
5. **P5 dedup-on-maintenance**（不阻塞 infra、最后做、是兜底）：喂近重复候选信号给 `KnowledgeReviewTask`（最轻）或加 `kc_dedup_nightly`。

**无 infra 即可先发**：P4a + P2 的 **propose-only 半截**（auto-approve 复用 live）。**gates 净新代码**：P2 的 match 半截 gate 在 P1。**不 gate**：复活维护 lane / matcher。

## 6. 边界

| vs | 本任务（tagging） | 对方 |
|---|---|---|
| **YUK-488（判分）** | 内容轴：题内容→KC ids，读 `question_text`，整页 vision 无关 | performance 轴：整页 vision 判**学生作答**，不碰 knowledge_ids。正交。 |
| **YUK-486（auto_enroll 幂等）** | 决定题归哪个 KC | 决定要不要重处理某上传。可组合、不重叠。 |
| **YUK-487（已发 student-grade 门）** | 与答对错无关、内容驱动，恒跑 | 已发；gate 上传学生作答判分。 |
| **matcher/embedding** | 建 **KC-keyed** 检索器（净新） | 现 `matcher()`/`poolFetch` 是 question-supply、dormant、错形状；只复用 cosine-threshold *pattern* + live `knowledge.embedding` substrate。 |

错因(cause)轴也在范围外：保持精确枚举匹配、无 embedding。

## 7. dreaming + 维护 lane 状态（直答）

**都活着，代码里都不 dormant。**
- **dreaming** 每晚 **北京 03:15** 无条件跑，*设计就是 proposal-only* —— 没高价值提议就沉默，薄/冷启数据上合法产 0。「没听到」的真因都是「活着只是安静」：(a) 薄数据→feeds no-op；(b) **worker 进程必须在跑**（`node dist/worker.cjs` / `pnpm worker:dev`，没 worker 就没任何 nightly job）；(c) `XIAOMI_API_KEY` 须设否则 run fail。查最近一次：看 `experimental:dreaming_scan` 事件的 `proposals_created`。
- **维护** 也每晚跑（**北京 03:00**），merge 路径全接线（agent *能* propose `merge`，accept *会* `applyMerge`、version-guard）。感觉「缺席」是因 **没 dedup 信号喂它** + **无可观测**「昨晚维护产了 N 条提议」。stale doc `lanes.md`（「merge 是 Phase 2+」）几乎肯定是「没听到」的来源 —— 那 doc **错了**，applier 是 live。

**所以别 budget「复活 lane」，budget「给 lane 一个 dedup 信号 + 一个能看见其产出的口」（即 §5/P5）。lane 今晚就在跑。**

## 8. Follow-up
- `MATCH_THRESHOLD` 标定（关联 YUK-396 matcher 阈值未调）。
- 修 stale doc `docs/modules/lanes.md`：维护 lane merge 误标「Phase 2+」（实际 `applyMerge` live）。
- 维护 lane 可观测：surface「昨晚 maintenance/dreaming 产了 N 提议」。
