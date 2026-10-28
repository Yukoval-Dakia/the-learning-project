# Strategy D 开工决策简报

**日期**：2026-06-05　**对象 main HEAD**：`63bc5867`（U 序列 grand closeout 之后）
**勘察核验**：本简报引用的所有 file:line 已对当前 main 复核，五份勘察报告的核心断言全部成立（无伪阳性）。

---

## 1. 现状一页

### 1.1 Strategy D 已落地什么

- **真实 ingest 端到端通道已活**：上传 → Tencent OCR → VLM → 人工/AI review → 入 `question` + `event` + `learning_record`。2026-06-01 首张真实试卷已端到端 ingest。`/record` 的 `vision_paper` tab 是 production 入口（`app/(app)/record/page.tsx:16,96-97,121`）。
- **Slice B observe-only auto-enroll 已接线并默认在跑**：OCR 成功后 fan-out 到 `auto_enroll` 队列（`src/server/boss/handlers/tencent_ocr_extract.ts:266-269`，失败只 log 不抛）；默认 `enroll=OFF / observe=ON`，每张真实 session 的 AI 打标结果**已经在写审计 trail**（`src/server/ingestion/auto-enroll.ts:132-138`）。**这意味着：从今天起 owner 每 ingest 一张卷，observe trail 就在自然积累 AI 打标质量证据——无需任何代码改动。**
- **新地基（U0-U8）已 ship**：知识级 FSRS、paper 模型 + `/practice`、chat 合并、profile studio。三个 subject profile（wenyan/math/physics）注册有效（`src/subjects/profile.ts:73-75`，启动期 `throwOnInvalid`）。
- **部署侧就绪**：`.env` 全部 required 变量 SET，R2_ENDPOINT 无 placeholder，preflight 应 PASS。唯一结构性缺口是 **`TUNNEL_TOKEN` 在 `.env` 中根本不存在**（cloudflared 依赖，NAS 启动前须从 shell 或 compose override 注入）。

### 1.2 YUK-164 六项真实账本

| 项 | 状态 | 核心证据 |
|---|---|---|
| #1 auto-enroll 接线 + session lifecycle | **DONE** | `tencent_ocr_extract.ts:266-269`（enqueue）；`auto-enroll.ts:147-168`（mode + 双重 guard，409 设计性关闭）；fbfb9a19 close-gaps |
| #2 OC-5 复查面 UI | **OPEN** | API 端完整（`/blocks` 附 `auto_enroll_observation`、`/revert` 已 ship）；UI 不存在——`record/page.tsx:16` 的 `ModeTab` 无 `auto_enrolled`，`VisionTab BlockRow.status` 无该值 |
| #3 review-UI prefill | **OPEN** | ADR-0026 §4 决策 no new columns；prefill 数据源 = `auto_enroll_observed` event payload；`VisionTab.BlockRow` 未含该字段 |
| #4 flag 开启 | **OPEN（依赖 #2）** | 三个 flag 读点代码完整（`workflow-judge-config.ts` + `auto-enroll.ts:132-141`）；env 未设置；#2 不存在则翻 ON 后用户无法可见复查/撤回 |
| #5 answer-grading（A2 真实 outcome） | **DONE** | `auto-enroll.ts:328` `const outcome = mistakeDraft?.wrong_answer ?? 'unanswered'`，不再恒 unanswered；commit `0717fb55`。**注意：此路径仅在 enroll flag ON 时执行**，observe 模式仍只写审计事件 |
| #6 LOW server-path 注记 | **DONE** | `registry.ts:126` + `mistake_enroll.ts:14-16` observe-only 注释在位 |

**一句话总结**：YUK-164 的**后端机制全部 DONE**（#1/#5/#6），剩下的三项（#2/#3/#4）是**一条 UI 链 + 一个 flag 翻转**，且彼此串行依赖（#4 ← #2）。

### 1.3 ingest ↔ 新地基 通/断矩阵

| 维度 | 状态 | 证据 / 断点 |
|---|---|---|
| (a) U2 知识级 FSRS ← ingested question | **通** | import 写入的 `knowledge_ids` 天然命中 due-list 的知识级切片（`due-list.ts:215` `knowledge_ids @> [kid]`）；首次 review 走 never-reviewed 切片（`:254`，由 `failure` attempt 驱动）。**唯一缺口**：`unanswered` item-bank 题无 attempt event，不自动进调度池（设计行为） |
| (b) U5 paper 模型 ↔ ingested 试卷 | **断（结构性不相交）** | `/practice` 只接受 `tool_quiz` artifact（`app/api/practice/route.ts:62,68`）；ingestion import **不写任何 artifact**（`import/route.ts` 只调 `enrollCapturedBlock`，grep 无 artifact 写入）。**一张真实 ingest 的试卷无法直接变成 `/practice` 可做的 paper** |
| (c) judge 上下文完整性 | **半通** | prompt 图片可进 judge（ingested `image_refs` 透传）；但**手写照片不进 judge**——`answerImageRefs` 写进 event payload（`paper-submit.ts:425`）却**没传给 `invoke()`**（`:194-198` 只有 db/question/answer_md/subjectProfile）；review SubmitBody 连字段都没有（`submit/route.ts:54-80`） |
| (d) solve-tutor（YUK-193）← ingested question | **通** | `startSolveSession(questionId)` 对任意 question 行可用；弱点：`solution-generate.ts:109` `figures_hint: null` 硬编码（figure 密集题质量下降，非断点） |

---

## 2. 候选 slice 分解

> 标注约定：**BE** = 纯后端（可自主推进）；**UI** = 含 UI（必须先做 design-doc pre-flight 等 owner 批准）。

### 候选 A：OC-5 复查面 UI + flag 开启链（YUK-164 #2→#3→#4）

- **解锁什么**：让 owner 能**看见** AI 自动/拟录入了什么、每行带 route/confidence/建议知识点、可逐行 revert；这是把 `WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED` 翻 ON 的**充分必要前置**——没有它，翻 ON = 盲飞。
- **工作量**：中。`AutoEnrolledPanel` 组件 + `/record` 新 `auto_enrolled` mode tab（读 `/blocks` 过滤 + `auto_enroll_observation`，每行 revert 调 `/revert`）；#3 prefill 是 `VisionTab.BlockRow` 加字段 + review-step 初始化 prefill。API 端全部 ready，**零后端工作**。
- **BE vs UI**：**几乎纯 UI**。必须走 design pre-flight。
- **依赖**：#4 ← #2；#2/#3 各自独立。**绑定 `/record` redraw wave**——`/record` 整页还是 legacy（49 处 inline style，未 loom 化），OC-5 是单独 slice 上还是随 `/record` redraw 上，wave-3 排期未定（报告 4）。
- **可行性评注**：loom-prototype `screen-record.jsx:179-219` **已有 `AutoEnrollPanel` 完整视觉原型**（含 observe-only 空态、示例行、revert 按钮），可直接作 pre-flight 视觉依据。但 brief 只给功能规格未给最终视觉裁决，且有 4 个未收口产品问题（见 §4）。**这是「看 AI 打标质量」的路径，不是「让真实数据驱动做题循环」的路径。**

### 候选 B：ingest → practice/FSRS 桥接（修报告 3 的「断」(b)）

- **解锁什么**：让一张真实 ingest 的试卷**能在 `/practice` 直接做**——把 session 的 `question_ids` 打包成 `tool_quiz` artifact（每题 = 一个 section assignment），写 artifact 行。这是真实数据飞轮「ingest → 做题 → FSRS 信号」闭环里**当前唯一的结构性断点**。
- **工作量**：中（约 1 slice）。新增一条「ingestion session → tool_quiz artifact」写路径：import 完成后调 `write_review_plan` 或新写 `create_ingestion_paper` tool，按现有 `tool_state.sections[].assignments[]` 形状打包。
- **BE vs UI**：**纯后端，可完全自主**。`/practice` 消费端已就绪，无需动 UI。
- **依赖**：无前置。独立可上。
- **可行性评注**：(a) 已通——ingested question 一旦有 `material_fsrs_state` 或 `failure` attempt 就进调度（`due-list.ts:215,254`）。但 `unanswered` item-bank 题不自动进池；本桥接正好把「整张卷」显式打成 paper，绕开 unanswered 不进池的问题，让 owner 能主动做整卷。**这是真实数据飞轮里「让 ingest 的题真正被复习/做」的最短结构修复。**

### 候选 C：纯使用路线（不写代码）

- **解锁什么**：owner 按 `docs/deploy/real-ingestion-provisioning.md` runbook **日常 ingest 真实试卷**，observe trail 自然积累 AI 打标质量证据；Layer-8（FSRS/Dreaming/Coach/brief）开始吃真实信号而非合成种子。
- **工作量**：**零代码**（除 `TUNNEL_TOKEN` 注入这一项部署修复）。
- **BE vs UI**：无。
- **依赖**：通道已活（§1.1）。
- **可行性评注**：**这是反过度工程偏好下成本最低的「飞轮启动」**——observe-only auto-enroll 已在每张 session 上自动跑（`tencent_ocr_extract.ts:266`），owner 什么都不建也在积累打标质量分布。**风险**：observe trail 目前**没有任何查看 UI**（候选 A 才是它的查看面），owner 只能靠 `/blocks` API 原始读 event payload；且文档无「打标质量合格」的 acceptance 标准（报告 5 §四/§五）。所以纯使用路线能积累证据，但**证据的可读性差**——这恰好是候选 A 要解决的。

### 候选 D：answer-grading EnrollTask（YUK-164 #5）

- **状态**：**已 DONE，无剩余工作**。`auto-enroll.ts:328` 已从 MistakeEnroll draft 取真实 `failure/partial/success/unanswered`，commit `0717fb55` 在 main 上。
- **唯一附带说明**：此真实 outcome 路径仅在 **enroll flag ON** 时执行；observe 模式仍只挂审计事件。所以「让 #5 的真实判分生效」= 翻 flag = 依赖候选 A 先上。**不构成独立候选 slice，列此仅为闭合 owner 的指定核查项。**

### 候选 E（附加，报告 3 浮现）：judge 手写照片穿透（修 (c) 半通）

- **解锁什么**：让用户**手写答案照片**能进 multimodal judge——目前单题 review 和 paper-submit 两条路径都只把文本答案送 judge，图片答案被丢。
- **工作量**：**极小**。两处 `invoke()` 各加一行 `student_image_refs`/`answer_image_refs` 透传 + SubmitBody 加字段（`paper-submit.ts:194` 已有 `input.answerImageRefs` 在手，只是没传进去）。
- **BE vs UI**：纯后端（review/practice 的 autosave 已能存 image_refs）。
- **可行性评注**：投入产出比高，但**对真实数据飞轮启动不是关键路径**——除非 owner 的真实做题习惯是拍手写照片而非打字。建议作为候选 B 的搭车小修，不单独成站。

---

## 3. 推荐首站

**推荐：候选 B（ingest → practice/FSRS 桥接），纯后端自主推进。**

**理由（对反过度工程偏好负责）：**

1. **真实数据飞轮的「闭环」缺的是 B，不是 A。** 飞轮 = ingest → 做题 → FSRS 信号 → Coach/brief 吃真实证据。今天 ingest 通了（§1.1）、FSRS 知识级通了（(a) 通）、但**ingest 出来的整卷无法进 `/practice` 做**（(b) 断，`practice/route.ts:62` 只认 `tool_quiz` artifact，import 不写 artifact）。这是闭环里**唯一的结构性断点**。修了它，owner ingest 的真实试卷立刻可做、可判、可进 FSRS 调度——飞轮才真正转起来。

2. **B 是纯后端，可完全自主，不触发 design pre-flight 摩擦。** 候选 A 虽然 backend ready，但它是**纯 UI**，必须走 design pre-flight + owner 批准，且绑定未排期的 `/record` redraw wave、还有 4 个未收口产品问题（§4）。先做 A 会被「等批准 / 等 wave 排期 / 等产品决策」卡住。B 没有这些前置。

3. **A 解决的是「看 AI 打标质量」，而打标质量证据本来就在 observe trail 里自然积累（候选 C 已在跑）。** 在还没有足够真实 session 之前就建 OC-5 复查面，是「为还不存在的数据量建审计 UI」——有过度工程嫌疑。更自然的顺序是：**先让真实数据飞轮闭环（B）+ owner 日常 ingest（C）积累足够 observe trail，再回头建 OC-5 复查面（A）去读它、并据此决定翻不翻 flag（#4）。**

**首站执行形态**：候选 B 为主 slice（自主，走 map→spec→plan→implement→verify→fix），搭车候选 E 的两行 judge 图片穿透（如确认 owner 做题会拍照）。**同时立即并行候选 C**——把 `TUNNEL_TOKEN` 缺口补上（§1.1），owner 当天即可开始日常 ingest，observe trail 与 B 的开发并行积累。

---

## 4. Owner forks（必须 owner 拍板）

### Fork 1：首站选「闭环后端（B）」还是「复查面 UI（A）」？

- **选项 A**：先建 OC-5 复查面 UI + 翻 flag——先要「看见并信任 AI 自动录入」。
- **选项 B**：先建 ingest→practice 桥接——先让真实数据飞轮闭环、整卷可做可判。
- **倾向：B。** 理由见 §3。A 的价值依赖足够 observe trail 已积累，而那需要先有顺畅的 ingest+做题闭环驱动 owner 持续用。**这是产品/feature 级分叉，须 owner 拍板。**

### Fork 2：flag `WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED` 翻 ON 的触发条件？

- **背景**：ADR-0026 说「仍需用户显式决定」但**没定义触发条件**（多少真实 session？打标精度阈值？），且文档无「打标质量合格」acceptance 标准（报告 5 §四/§五）。
- **选项 A**：定一个量化门槛（例如「连续 N 张卷 observe trail 的 knowledge_id 命中率 ≥ X%」）再翻。
- **选项 B**：保持人工判断，owner 看够了 observe trail 凭感觉翻，不预设阈值。
- **倾向：B（先不定阈值）**，但**前提是 OC-5 复查面（候选 A）已上**——否则 owner 无可读的 observe trail 去「看够」。即此 fork 的答案与 Fork 1 的顺序耦合。

### Fork 3：合成 seed 在真实数据进来后的去留？

- **背景**：文档**没声明 seed 退役**（报告 5 §三）。`layer8_e2e.db.test.ts` 跑在合成数据上作 regression guard。
- **选项 A**：合成 seed 长期保留**仅作测试 harness**，真实数据替代的是「生产运行时信号来源」（FSRS/Dreaming/brief），两者分层。
- **选项 B**：真实数据足够后，连测试也迁到真实 fixture，退役合成 seed。
- **倾向：A。** 测试 harness 用确定性合成数据更稳；真实 fixture 做 regression 会引入数据漂移。建议明确这条分工写进文档（当前是推断，非实证）。

### Fork 4（轻量）：`TUNNEL_TOKEN` 注入方式？

- **背景**：`.env` 无此键，cloudflared 依赖它（报告 2 (d)）。
- **选项 A**：写进 NAS 的 `.env`（与其他凭证同处）。
- **选项 B**：宿主 shell `export` 或 compose override 注入（凭证不落 `.env` 文件）。
- **倾向：B**（与 runbook「local dev 不放真实凭证」一致的隔离风格），但这是部署偏好，owner 一句话即可。

---

## 5. 不做清单（本章明确不碰）

1. **不翻 `WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED` flag**——在 OC-5 复查面（候选 A）落地前翻 ON = 盲飞，违背 evidence 留痕偏好。flag 读点代码已完整（`auto-enroll.ts:132-141`），无需动代码。
2. **不给 `question_block` 加 `ai_suggested_*` / `ai_judge_*` 列**——ADR-0026 §4 已决策 event-marker-only，#3 prefill 数据源是 `auto_enroll_observed` event payload，**无需新 schema 列**（否则要写 migration + 改 schema allowlist，纯增工）。
3. **不做 slice-2b figure 重归属（YUK-163）**——runbook §7 显式列为 out of scope，属 OCR pipeline 完善，非 capture UX / 飞轮。
4. **不引入语音口述 / URL 导入录入来源卡**——仅存在于 loom prototype（`screen-record.jsx`），无 Linear 编号、无后端 spec，属 design exploration，非 committed scope（报告 5 候选 D/E）。
5. **不修 `solution-generate.ts:109` 的 `figures_hint: null`**——是弱点非断点，solve-tutor 对 ingested question 已通（(d)），figure 密集题质量退化可后续单独处理。
6. **不碰 `/record` 整页 loom redraw**——除非 Fork 1 选了 A 且决定随 redraw wave 上。`/record` 整页 legacy 化是独立的 UI 债，不应混进飞轮闭环这一章。
7. **不动 OPENAI_API_KEY / Mem0 fact layer**——warn 级降级，ingestion 主链路不阻断（报告 2 (c)），属 config not code。

---

**Linear capture gate**：本简报为决策简报，本身不产生需立即开 issue 的代码 follow-up。两个**应建/补 Linear issue 的实证缺口**供 owner 决策后落单：(1) 候选 B「ingest→practice tool_quiz artifact 桥接」当前**无 Linear 编号**（报告 5 指出 Strategy D「not yet ticketed」）——若采纳为首站应建 issue；(2) 候选 E「judge 手写照片 student_image_refs 透传」（`paper-submit.ts:194` / `review/submit/route.ts:54`）是实证缺口，建议建独立小 issue。是否落单取决于 Fork 1 的选择，故此处不擅自创建，留给 owner 拍板后执行。