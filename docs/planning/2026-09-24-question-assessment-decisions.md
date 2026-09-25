# YUK-1038 题目契约迁移 — owner 决策记录

日期：2026-09-24 · 关联 YUK-1038 · **状态：D1–D19 已批准；无业务实施/UI 代码；Jev smoke + 只读 census 已完成；Q20 UI preflight 与 Q21 ticket 拆分 2026-09-25 已批准（YUK-1043–1059）；仅剩 final implementation-ready confirmation 待 owner**

相关：[implementation grounding](2026-09-24-question-assessment-implementation-grounding.md) · [模型提案](2026-09-24-question-assessment-redesign.md)。

## 说明

- 本文件只记录 owner 通过 question tool 给出的**已批准**决定（APPROVED）。
- **工程推演（elaboration）不等于批准**；待定项即使有合理默认，也标为 PENDING 未批准。
- 批准的是**产品/契约方向**，不是实现；本文件不代表任何能力已上线或已验收。

## 已批准决定（APPROVED）

### D1 — 核验后自动准入

- model-proposed marking rules 允许在**结构校验 + 独立核验**通过后**自动准入**。
- 必须**显式标注为 system authored**，**不是 official**。
- 未解决/未通过核验的规则**保持 withheld**，不自动准入。

工程细化（未批准）：第二模型“同意”本身**不构成证明**；**准入验收标准仍需 finalize**。

### D2 — 联合组内同知识点聚合

- 每个**已定稿的依赖 evaluation group occurrence**，对每个 KC **最多一条 judge-derived mastery observation**。
- **真实独立的小题仍各自独立**。
- **不得**把整张 paper/session/day 去重。
- **不得**合并或删除 FSRS physical child targets。
- 工程细化（未批准）：分数→学习/rating 的换算公式待定。

### D3 — 分开纠正展示与学习

- 不可 replay 的历史纠正**可以展示**，但须**清楚标明学习状态未变**，保留 original/baseline。
- 缺失的原始上下文**不得补造**。

### D4 — 满足条件自动生效

- appeal **自动生效**仅当：输入完整且不可变、规则已准入、结果有效性、CAS、以及**所需学习 replay 全部通过**；否则**保持 held**。
- 用户**手工评级不得被静默覆盖**。
- 人工确认**不能**绕过缺失证据/replay；可按 D3 授权**标注为 display-only**。

### D5 — 已接收答案零丢失

- 已接收（acknowledged）的答案，**含 202**，必须**守恒/零丢失**。
- 可接受**更长的维护窗口**；**不做有损的旧镜像回滚**。
- **不批准**任何生产运维或维护窗口本身；**限时可安全中止**另行考虑。
- 未保存的浏览器草稿需要**显式处理**。

### D6 — 真实错误可双向纠正

- 对**同一原始任务（same original task）**，**经证明的答案键/评分依据缺陷**可**双向**调整历史分数（降低或提高），须保留**精确的原始与纠正后依据 + replay**。
- **新的更严格政策/权重/有效方法变更不追溯**（not retroactive）。
- **题面/要求变更** = **新 issuance**。

### D7 — 定位全部，按授权批次修复

- 对错误规则**自动定位全部受影响历史记录**。
- **估算规模/成本**后按**预算授权批次**纠正；**不是**不加区分地重判全部历史。

### D8 — 仅重解读原证据

- appeal 理由**不是**新答案。
- 允许**重新 OCR / 查看被遗漏的原始图片**。
- 提交后新增步骤/页面/上传，默认 = **新 attempt**；**没有 evidence-amend 工作流**。

### D9 — 允许显式非自动模式

- 任意题目可走**显式手动/自评**并带**显式 provenance**；仅允许**手动学习效应**；**绝不推断 AI 正确性**。
- 现有手动路径保留。
- 工程细化/待定：**手动→θ̂ 的精确映射仍待定**。

### D10 — 扩展常见原始证据

- 扩展常见原始证据：**audio/video/PDF/plaintext** 原始附件，上传 + 安全播放/下载，与图片并列；format/size/security 校验。
- **不做**录音工作站/代码执行/媒体编辑器。
- 实施为 **full release**，**不做 image-only fallback**。

### D11 — 统一服务端自动保存

- **统一服务端自动保存**：**全部正式练习面**（含 solo+placement）在 **pinned issuance** 上自动保存；状态 saving/saved/error；**只有服务端 ack 才恢复 promise**。
- 旧的未保存浏览器草稿在切换时 **warn/save/export**，**不补造**。

### D12 — 批准两次调用，合计 ≤ $0.01

- 批准**两次**调用，**合计 ≤ $0.01**：synthetic 非敏感 **Noul 一次、Choice 一次**；**不自动重试、不走 advanced**；**仅首次 smoke，不是 accuracy**。
- **执行已完成（FINAL）**：**2/2 paid calls、无 retries、总计 $0.00003024**；仅 wire/auth/cost，**无 accuracy 结论**（详见上文 smoke 证据段）。
- **不从前预算池挪额度**。

### D13 — 采用有依据的局部证据

- 按 **per-KC / group occurrence** 采用**有支持的、映射到 scoring unit 的证据** + **MATCHED measurement/difficulty** ⇒ success 1 / failure 0 / **abstain（不更新）**。
- **ambiguous/partial 未局部化** ⇒ **abstain**；**每 KC 最多 1 条 observation**。
- **空白**可按已声明 marking 计零，但**默认不当作全部 KC failure**。
- **Score unit ≠ group/slot**；总分只聚合一次。
- 工程约束：当前 **one-bit conjunctive updater** 无法用 global bit 表达 mixed KCs，也不能按点重复调用；需要 **bounded evidence adapter**，共享 global update 只做一次。
- **无 fractional θ / 不引入新 IRT**。

### D14 — 采用三等级建议

- 建议三等级：**correct→good、partial→hard、incorrect→again**；允许**手动覆盖**；**invalid/unmapped ⇒ none**。
- group scheduler 使用**显式、版本化 scope**；**不合并 card、不重复 auto ops**。

### D15 — 自行评级仅影响 FSRS（新 runtime）

- **自行评级仅影响 FSRS**（**仅新 runtime**）；**不做 self-report θ̂/calibration**。
- **有效判分证据独立地可以更新 θ̂**；**历史基线不变**。

### D16 — 排除被答案帮助污染的证据

- 得分**保留但标注 assisted**；受影响的 **hard mastery/calibration 排除**；**允许显式手动 FSRS**。
- **无害澄清不自动惩罚**；**不确定 ⇒ abstain**。

### D17 — 严格准入合同

- 准入门槛（**全切片必须满足；不是统计普适性声明**）：
  - deterministic comparators/aggregation/idempotency/safety invariants **zero-failure**；
  - 每个启用模型的能力切片 **≥30 holdout cases**，按 **family×source 隔离**；
  - **zero observed severe errors**（clearly-wrong 被判 fully correct、fully-correct 被判 zero、fabricated evidence、dependency/score-cap 违规、missing/unreadable evidence 被计非零）；
  - 有可靠 **per-point gold** 时 **per-criterion agreement ≥95%**；
  - 最终 pipeline 在 auto-admitted 切片上 **coverage ≥95%**；
  - **Jev 直接覆盖 ≥80%**，否则该切片只用 advanced executor；
  - 阈值在 **dev set** 上调，**holdout 不得再调**；
  - 失败的切片 **不自动准入**。
- **边界**：**不是**统计普适性（universality）声明；**官方 rubric descriptors 本身不等于 essay gold**（需要 officially-scored responses 或 owner-reviewed anchors）。

### D18 — 独立评测预算 ≤$5

- **与已完成的 $0.01 smoke 分开**的独立评测预算，**上限 $5**。
- 仅 **Jev（OpenRouter）+ MiMo text/vision** 两类 lane（价格已知）；**不使用价格未知模型**。
- 覆盖 dev/holdout 样本、Jev escalation、最多 **200 次独立核验调用**；**所有 retries 计入**。
- 总预算内**最多 800 次 model requests**，并设 **per-call input/output caps**；**首次触顶即停**。
- 未知成本按保守值**预留**。
- 语料 = public officially-scored material / synthetic / authorized desensitized；证据经 app `ai_task_runs` **封存**。
- **仅在 harness + budget gate 就绪后运行**；**不授权实施启动**。

### D19 — 只读盘点与隔离准备

- **先做 explicit-target preflight**，再做**只读生产 census**（分类型计数、referential integrity、snapshot/image missing、in-flight state；**报告不含原始 learner content**）。
- 另做**本地隔离 restore 准备**。
- **明确不做**：生产写入、暂停、清队列、flip flag、migration、deploy。

### 学习真值表（D13–D16 覆盖的状态）

fully correct / wrong-localized / mixed partial / partial KC / holistic level / blank / unreadable / manual / assisted / regrade。

### 明确被拒的旧提案（仅作历史可读）

- partial→1。
- worst-wins。
- rejudge FSRS immune target。

以上三条 **REJECTED**，仅保留为可读历史。

### Source findings（source-only，非生产事故）

- 当前 **solo partial calibration exclusion 存在可绕过路径**：`src/capabilities/practice/server/review-settlement.ts:525–529`（calibration 仅由 `body.auto_rate` 门控）与 `src/server/mastery/recalibration.ts:483–486`（objective-route + partial 排除）。source 审阅发现，**非生产事故**；已纳入 YUK-1038 跟踪。

## Provider 选择（owner 指示，OpenRouter 公开文档已核验）

Owner 原句（verbatim）：

> 我已写入openrouter apikey到.env，你可以透过or调用jev模型。

- 记录：provider 偏好 **OpenRouter**；owner 称已提供凭证并授权调用。
- 边界：本文件**不记录任何 secret**；**不假设 key 已验证或可用**。
- **key presence 已检查，不等于 auth 成功**：parent 用 node dev26.8.1 `process.loadEnvFile` 只回显布尔 `env exists/loaded/key_present=true`，**未回显 secret**；这只证明 env 存在与 key 字段在场，**不证明鉴权成功**。

### OpenRouter 公开文档核验（librarian 返回）

- **原生 typed 端点**：`POST https://openrouter.ai/api/v1/systemone`（或 `/api/alpha/decisions`）；**不是 chat 门面**（NO chat façade）。
- **pinned request type**：`typesafe/jev-1.13`；实际 canonical reported 为 `typesafe/jev-1.13-20260917`。
- **输出** `decisions`；**text-only 输入，32k context**。
- **provider 约束**：only TypeSafe provider；only/order TypeSafe；`allow_fallbacks=false`；`max_price` prompt 0.042 / completion 0（USD/M）；API unit input 4.2e-8 / output 0。
- **state+questions typed**，原生 **Noul / Choice / Score**。
- **`probabilities`/`confidence`/`usage.cost` schema 为 OPTIONAL**；缺失时**不得补造**。
- **`confidence` 是分布形状，不是 accuracy；Score 是 expectation，不是 student points**。
- **application 层 Jev→advanced 是独立 invocation**，**不是** model fallback array。
- 公开来源：OpenRouter docs/guides/community `jev.md`、`jev-tutorial.md`、`typesafe-sdk.md`；`/api/v1/models?output_modalities=decisions`；model/endpoints；`docs.typesafe.ai/sdk/python`。

### OR smoke（D12）— FINAL（wire/auth/cost smoke，非 accuracy）

- **2/2 paid calls 已用完，无 retries，总计 $0.00003024**（远低于 $0.01）。
- `POST https://openrouter.ai/api/v1/systemone`；model request `typesafe/jev-1.13` → response `typesafe/jev-1.13-20260917`；provider **TypeSafe**。
- **Noul**：344 in / 21 out，$0.000014448；schema-optional 的 `confidence`/`probabilities` **缺失**（观测为不存在，**不补造**）。
- **Choice**：376 in / 38 out，$0.000015792；`probabilities{account 0, frontend 0.25, payments 0.75}` sum 1.0，`confidence 0.63`。
- Latency 309/401ms；cost 精确等于 input_tokens×4.2e-8。
- 首次尝试在 inference 前停止（catalog query 误用 default text，**0 paid**）——保留为 **attempt0 artifacts**。
- Artifacts：`/private/var/folders/bt/rcf5s7tx3s93g3dz0046y96w0000gn/T/opencode/yuk1038-or-jev-smoke-YpsPva/`（manifest.json、paid_state.json、response-noul.json、response-choice.json、script+fixture digests）。
- **本 smoke 仅证明 wire/auth/cost 通路，不作任何 accuracy 结论。**

### 设计影响

- **OpenRouter 偏好取代“仅直连 TypeSafe”设计**；但**保留 typed sibling `AiRunLifecycle` seam（非 chat）**；**精确集成包/接缝以后定**。
- 原“直接 TypeSafe typed transport 提案”为 **provisional**，不得据此宣称 OpenRouter 不支持。
- **付费 smoke 范围与 ceiling 已由 D12 限定**（2 次、≤$0.01）；除此之外**不调用**。

## 只读生产 census（D19 第一部分）— FINAL（只读，无写入）

- compose project `the-learning-project`；postgres pgvector `0.8.2-pg16` healthy；db `loom` 67MB。
- **REPEATABLE READ READ ONLY** session 已确认 `transaction_read_only=on`；46/46 queries，0 gaps，91ms；仅 SELECT/WITH whitelist；最后 **ROLLBACK**。
- 关键计数：
  - **114 questions**（pool-visible 66：65 active + 1 NULL；draft 48）。
  - sources：web_sourced 72 / quiz_gen 32 / mind_probe 6 / intervention_diagnostic 3 / manual 1。
  - kinds：choice 55 / computation 26 / short_answer 16 / fill_blank 12 / true_false 3 / derivation 2。
  - **physical part 轴：0 rows**（data 中无 physical parts）；**structured present 1/114**；**answers table 0 rows**。
  - judge events 9，全部 success；1 attempt（failure，带 question_snapshot，无 `part_ref`）；0 appeals/corrections/reprojects/judge-pending。
  - verify intents 104；FSRS knowledge 13 / question 2；mastery knowledge 7 + ability_global 1；difficulty_calibration_label 0；item_calibration 96。
  - sessions 11（2 tutor active）。
  - pgboss v37：completed 104,302 / outstanding 27（**全部为 DLQ recovery 队列**：memory_event_ingest_dlq 19、dreaming 2、knowledge_maintenance 2、coach/note_refine/quiz_gen/quiz_verify 各 1）/ failed 27 / 29 schedules / subscriptions 4 active。
- deterministic-key readiness：20/40 pool choice rows headline-ready；0 numeric contracts；answer_class exact 45。
- **历史 served-snapshot 可重建性 ≈ nil**。
- Artifacts：`/private/var/folders/bt/rcf5s7tx3s93g3dz0046y96w0000gn/T/opencode/yuk1038-census-20260924-223104/`。
- Restore 预备：容器内 pg_dump/pg_restore 16.14（host 无），磁盘 491Gi free；**daily backup STALE**（`loom-daily-20260913.dump`，last success 09-13，launchd 疑似已停）——记为 operational finding；**未执行 restore 演练**（owner-gated，待 migration code 存在）。
- **风险画像收缩**：0 physical parts、0 answers rows、9 judge events 显著缩小历史迁移风险，但**契约仍按 general case 构建**（不为当前沙盒规模削能力）。

## 待 owner 决策（PENDING — 未批准，即使有合理默认）

- ~~**Q20 UI 正式 design preflight 批准**~~ — **2026-09-25 owner 已批准**（`docs/design/2026-09-24-assessment-ui-preflight.md` §2–§9 一组：文件清单/组件类型/交互规格）。
- ~~**Q21 ticket 拆分批准**~~ — **2026-09-25 owner 已批准**；已按 §17 work DAG 建 Linear 依赖票 **YUK-1043–YUK-1059**（17 票，parent=YUK-1038，label `ready-for-agent`，blockedBy 已落）。
- 之后：**final implementation-ready confirmation**（实施前最终确认）— **仍待 owner**。

此前另列的 learner-visible rubric/披露、omission/finality/assistance policy、cutover measured window、手动→θ̂ 精确映射，纳入 **Q21 ticket 拆分**一并定案，不再单列 owner 决策项。

已由 **D6–D19** 定案、不再单列 pending：corrected rubric 降分影响范围（D6/D7）、evidence amendments（D8）、unsupported modality/manual practice（D9/D10）、UI 自动保存（D11）、受限 smoke（D12）、partial→learning/rating 与局部证据映射（D13/D14）、自行评级与 θ̂ 边界（D15）、被帮助证据排除（D16）、admission acceptance criteria（D17）、evaluation corpus/预算（D18）、库存 census/隔离准备（D19）。

SQL/locks 等工程细节**不是** owner 决策项。

## 证据任务状态

- 初始 grounding（Round 1）证据任务**已完成**（lane A/B/C/D source-only），**当时零模型调用**。
- 轮二裁决（D6–D12）、轮三（D13–D16）、轮四（D17–D19）**已完成**并落盘。
- **D12 OR smoke 已 FINAL**（2/2 calls、$0.00003024，见上）；仅 wire/auth/cost，**无 accuracy 结论**。
- **D19 只读生产 census 已完成**（见上）；**restore 演练仍待**（owner-gated，待 migration code 存在）。
- **D18 独立评测预算已批准（≤$5），但 actual-output 评测仍待运行**（harness + budget gate 就绪后；不授权实施启动）。
- **UI preflight 已起草**（`docs/design/2026-09-24-assessment-ui-preflight.md`，source-check only，**待 owner 正式批准 Q20**）；designer 报告曾误标决策 ID，已纠正为 **D9 manual / D10 media / D11 autosave**。
- **无全产品浏览器证据**；**暂无新 ADR**：待 parent reconcile；本文件仅作决策记录。
