# 功能目标地图 + 可维护性证据（架构重设计调研产物）

> 2026-06-10 · brainstorming 阶段调研产物，供架构重设计讨论引用。
> 产出方式：13+ agent workflow（11 域级功能提取 + 2 诊断 + opus 统合 + 完整性批评 + 5 补查）。
> 本文档**只描述功能目标与证据**，不含架构方案；方案见后续 spec。

# 功能目标地图 — AI 学习工具（单用户 · 自托管）

> 本文档只谈**功能目标**（系统替用户做什么、为什么），不谈代码架构或技术实现。文件路径仅作为「证据指针」标注，用以追溯目标声明的来源。
> 成熟度图例：**shipped**=已交付 · **partial**=半实现 · **scaffold**=占位/骨架

---

## 0. 产品定位与一句话愿景

一个**单用户、自托管（NAS）、事件驱动**的多学科 AI 学习工具。核心命题：AI 不是聊天助手，而是与用户**对等的一等行为体（first-class actor）**——它能主动归因、提议、生成、规划，但所有主动行为都**留痕、可审计、可回滚**。系统围绕「错题复习 + 知识图谱 + AI 主动推荐」三大支柱构建，通过纯数据声明（SubjectProfile）支持多学科扩展。

产品承诺分四档：
- **A 档** 错题复习闭环 — 已完整交付
- **B 档** 「我想学 X」路径生成 — 部分实现（现有图 sequence 提议完整，新建主题/补子节点提议待）
- **C 档** AI 主观能动（夜间 dreaming / maintenance / 主动提议）— 大部分交付，深度排序待
- **D 档** 跨域一等对等行为体（跨页面 Copilot + 可见 tool-use）— 已落地，DomainTool Registry 全量仍在建

---

## 1. 用户核心闭环（端到端旅程）

系统的功能目标可归约为四条互相咬合的端到端旅程。

### 旅程 A：错题闭环（录入 → 归因 → 巩固 → 复习）— `shipped`
> 这是产品的「重力中心」，A 档承诺的完整交付。

```
录入错题（手打 / 拍照 / 文档导入）
   → AI 自动归因（10 类错因，挂到具体知识点）
   → AI 生成变式题（cause-targeted，受控 ≤3 在途，双 pass 质检）
   → 进入 FSRS 复习队列（按知识点调度）
   → 复习作答 → AI 判分 + 评级建议 → FSRS 状态更新
   → 会话结束 AI 短结 → Coach 周报复盘
```
用户价值：做错的题不会丢，AI 自动诊断**为什么错**而非只记录错了，通过变式练习避免背答案，按遗忘曲线智能安排复习时机。

### 旅程 B：知识建构（材料 → 结构化 → 知识图谱 → 笔记产物）— `shipped`（图谱）/ `partial`（意图驱动）

```
上传材料（PDF / DOCX / 图片）→ OCR/VLM 三层提取 → 题目块切分 → 知识点自动标注
   ↓
知识图谱：树形骨架（parent_id）+ 网状关系边（5 类 typed edge）
   ↓
「我想学 X」→ AI 拆解为 1 hub + N atomic 学习项 → 异步生成五段式笔记
   → 笔记自动质检 → 嵌入自测题 → Living Note 持续优化
```
用户价值：把外部材料转成可练可查的结构化资产；知识以网状结构组织，能看到前置/关联/对照/应用/派生关系；输入一个主题就能拿到学习路径和笔记框架。

### 旅程 C：AI 主动协作（夜间自审 → 提议收件箱 → 用户审批 → 落地）— `shipped`（管道）/ `partial`（深度）

```
夜间批量（错峰 cron）：
   2:00 知识点提议 → 2:30 知识边提议 → 2:45 Hub 同步 → 3:00 知识维护
   → 3:15 Dreaming 综合提议 → 3:45 Coach 今日计划 → 3:50 目标范围
   ↓
所有产出 → 统一提议收件箱（9 种 proposal kind）
   → 用户审批（接受/改方向/改类型/忽略/撤回）
   → owner-service 落地 + 留痕 → 接受率信号反馈 AI 排序偏好
```
用户价值：AI 在用户离线时自动分析学习数据，第二天起床收件箱里能看到可执行建议（合并节点、补关系、补学、归档），所有建议带推理与证据，可看可回滚。

### 旅程 D：对话式陪伴（跨页面 Copilot 抽屉）— `shipped`（对话/工具）/ `partial`（呈现层深化）

```
全局 Copilot 抽屉（跨 routes 常驻）
   → 自由答疑（结合错题/知识图谱/今日计划上下文）
   → 结构化教学（explain / ask_check / end）
   → 工具调用（仅 propose）：知识 mutation/edge、错题归因、变式、出题/组卷、学习项生命周期
   → primary_view hero 呈现（artifact / tool_result / interactive 沙盒）
```
用户价值：跨页面随时能问的学习导师，能讲解、陪练、出题、整理知识树、规划复习；所有写操作只提议，需用户确认。

---

## 2. Capability 聚类（跨域合并 · 标注成熟度 + 证据路径）

按功能内聚合并跨域重复项。每条 capability 给出最具代表性的一处证据指针。

### 2.1 录入与资产管理

| Capability | 描述 | 成熟度 | 证据路径 |
|---|---|---|---|
| 多模式录入入口 | 学习记录（疑问/顿悟/反思/资料）、手动错题、拍照（单题/试卷）、AI 自动抽取面板，统一入口 | shipped | `app/(app)/record/page.tsx` |
| 图片上传与内容寻址存储 | PNG/JPEG/WebP ≤8MB，SHA-256 内容寻址存 R2，自动去重 | shipped | `app/api/assets/route.ts`, `src/server/r2.ts` |
| PDF → 图片渲染 | ≤30MB / ≤15 页，PDFium 渲染为 PNG，加密/损坏检测 + 30s 超时 | shipped | `src/server/ingestion/pdf-render.ts` |
| DOCX 双线录入 | 文本路径（pandoc→Markdown）vs 视觉路径（含 MathType→LibreOffice→PDF→图片），自动路由，原图留证 | shipped | `src/server/ingestion/docx/route-classify.ts` |
| 三层 OCR/VLM 提取 | 专用 OCR 默认（GLM/腾讯可切）→ VLM 兜底（mimo-v2.5）→ heavy 模式；结构化抽取走确定性 API 不交 LLM | shipped | `src/server/ingestion/glm_ocr.ts`, `src/ai/registry.ts` (VisionExtractTask) |
| 题目块组装与切分 | OCR 文本层 + VLM 结构层融合，跨页题组装，bbox/角色/置信度标注 | shipped | `src/server/ingestion/block-assembly.ts` |
| 知识点自动标注 | TaggingTask 从科目知识树推荐 ≤5 个知识点 + 置信度 | shipped | `src/server/ingestion/tagging.ts` |
| 渐进式自动入库 | 观察模式（仅写审计事件）→ 自动模式（flag-gated，置信度最弱链 ≥阈值才入库），保守默认 OFF | shipped(观察)/partial(自动) | `src/server/ingestion/auto-enroll.ts` |
| 录入会话管理 | type='ingestion' 会话，断点续传 + 进度跟踪 + 列表查询 | shipped | `app/api/ingestion/route.ts` |

### 2.2 复习与练习

| Capability | 描述 | 成熟度 | 证据路径 |
|---|---|---|---|
| FSRS 间隔复习 | ts-fsrs 标准实现，**调度单元 = 知识点**（无标签题 fallback 题级），两阶段卡片（答题→对照评分），会话开始/暂停/恢复/放弃 | shipped | `app/(app)/review/page.tsx`, `src/server/review/fsrs.ts` |
| 到期队列生成 | 区分未复习/逾期两段，跨学科 round-robin 平衡，目标软排序 | shipped | `src/server/review/due-list.ts` |
| 多路由 AI 判分 | exact / keyword / semantic / steps / unit_dimension / multimodal_direct，按题型科目自动选 | shipped | `src/core/capability/judges/index.ts` |
| 评级建议 + 判题顾问 | 据判分 outcome + 错因倾向建议 FSRS 评级；预提交顾问（不写事件/FSRS）；判错可申诉 | shipped | `src/server/review/rating-advisor.ts`, `app/api/review/advice/route.ts` |
| 成卷练习 | 今日/往日分区，按来源筛选（Coach 排期/自建/笔记小测/导入），逐题提交 + 反馈缓冲 | shipped | `src/server/review/paper-detail.ts`, `paper-submit.ts` |
| 反馈缓冲机制 | judge_now_show_later 策略，visible_to_user 服务端强制门控，做完才显示 | shipped | `src/server/review/paper-submit.ts` |
| 变体轮换选择 | recall 题重复原题，application 题在变体家族轮换避免死记 | shipped | `src/server/review/variant-rotation.ts` |
| 解题会话 + 分级提示 | Socratic 分级提示（hint 0-20），手写图/文本提交，失败入归因队列；参考解答 lazy 生成 | shipped | `app/api/questions/[id]/solve/route.ts` |

### 2.3 知识组织

| Capability | 描述 | 成熟度 | 证据路径 |
|---|---|---|---|
| 知识树形浏览 | parent_id 层级骨架，掌握度环 + evidence + 错题数 + 边数 | shipped | `app/(app)/knowledge/page.tsx` |
| 知识图谱可视化 | Cytoscape/SVG 网状视图，5 类关系视觉映射（前置→/相关↔/对照⇆/应用→/派生↳） | shipped | `src/ui/KnowledgeGraph.tsx` |
| 节点详情聚合页 | 元数据 + mesh 邻居 + 主笔记内联 + 标签笔记 + interactive artifact + 反链 + 活动时间线 | shipped | `src/server/knowledge/node-page.ts` |
| 手动 + AI 边/节点提议 | 手动建边（uniq 冲突 409）；AI 提议 accept/reverse/change_type/dismiss，幂等 + 行锁防并发 | shipped | `src/server/knowledge/edges.ts`, `src/server/proposals/actions.ts` |
| 科目视角派生 | 从 domain 字段派生科目视图（getEffectiveDomain 向上查找，≤32 层防循环），**绝不给实体加 subject 列** | shipped | `src/server/knowledge/subject-resolution.ts` |
| Hub 自动关联（Mesh Curation） | 4 条规则纯函数聚合相关原子笔记（子主题/前置/派生/对照），provenance chip 标注 | shipped | `src/server/knowledge/hub-mesh.ts` |
| 掌握度派生视图 | 3 色环（evidence<3 不展示避免误导），从事件 30d 半衰期投影，**不存储 stored mastery** | shipped | `src/ui/primitives/MasteryRing.tsx`, ADR-0012 |

### 2.4 学习意图、目标与产物

| Capability | 描述 | 成熟度 | 证据路径 |
|---|---|---|---|
| 学习项状态管理 | 待办→进行中→完成→养护→归档状态机，健康度条（关联知识到期统计），层级父子 | shipped | `app/(app)/learning-items/page.tsx` |
| AI 意图拆解 | 「我想学 X」→ 1 hub + N atomic（atomic 数=子节点数，不编造） | partial | `src/ai/registry.ts` (LearningIntentOutlineTask) |
| 学习目标（北极星） | 长期方向透镜，跨科目 scope_knowledge_ids + sequence_hint，**只 ADD 方向永不 INHIBIT**（ND-5） | partial | ADR-0025 (goal 表) |
| Artifact 多态产物 | Note（hub/atomic/long 共用 body_blocks）+ Tool（tool_quiz），三态块树，TipTap 编辑 | shipped | ADR-0020, `app/api/artifacts/[id]/body-blocks/route.ts` |
| 五段式笔记生成 | definition/mechanism/example/pitfall/check，异步生成 + 双 pass 质检 + 嵌入自测题 | partial | `src/ai/registry.ts` (NoteGenerateTask/NoteVerifyTask) |
| Living Note 动态优化 | 5 信号触发精炼（错题/掌握度/错误率/停留/Dreaming），≤3 改直接应用否则转提议 | scaffold→shipped(handler) | `src/server/boss/handlers/note-refine.ts` |
| 块间引用追踪 | cross_link / embedded_check 块级双向引用，修改时追溯影响范围 | shipped | `src/db/schema.ts` (artifact_block_ref) |

### 2.5 AI 任务系统（30+ 专用任务）

| Capability | 描述 | 成熟度 | 证据路径 |
|---|---|---|---|
| 错题归因分析 | profile-scoped 10 类错因，主/次类型 + 分析 + 置信度，写 judge event | shipped | `src/ai/registry.ts` (AttributionTask) |
| 变式题生成 + 验证 | cause-targeted 变式 proposal，3 层防繁殖 + variants_max=3，双 pass 验证 | shipped | `src/server/boss/handlers/variant_gen.ts`, `variant_verify.ts` |
| 搜索驱动组卷 + 验证 | 规划→Tavily 搜 SOURCES→写原创题（自声明 source_refs）→闭书验证（事实/抄袭/知识命中） | shipped | `src/ai/registry.ts` (QuizGenTask/QuizVerifyTask) |
| 题源网络搜索 | 给 subject+考点 用 Tavily 搜现成题重构为 SourcedQuestion（带 provenance），HTML/TEXT 优先 | shipped | `src/ai/registry.ts` (SourcingTask) |
| 单题起草 | knowledge/material 种子起草原创题，可指定题型难度，写 draft + proposal | shipped | `src/server/ai/question-author.ts` |
| 题解生成 | 给无 rubric 题生成参考解答 + 工作过程，让 judge 能判真实录入题 | shipped | `src/server/ai/solution-generate.ts` |
| 相邻题块合并提议 | 找被切开的同一逻辑题，仅 propose 不 auto-merge | shipped | `src/ai/registry.ts` (BlockAssemblyTask) |
| 主动教学对话 | TeachingTurn（teach/quiz/check/closing），ask_check 物化检查题 | partial/shipped | `src/server/copilot/skills/teaching-skill.ts` |
| 复习意图 + 会话短结 | 队列开场白（≤80 字）+ 会话短结（≤120 字三段），禁套话 | partial/shipped | `src/ai/registry.ts` (ReviewIntentTask/SessionSummaryTask) |
| 记忆简报编写 | per-scope 三窗口（近周/近月/长期）markdown + evidence_id，长期新鲜度评分 | shipped/partial | `src/ai/registry.ts` (MemoryBriefTask), ADR-0017 |
| 目标范围推断 | 模糊目标标题 → 推断 knowledge_ids + 粗略顺序 | shipped | `src/ai/registry.ts` (GoalScopeTask) |
| 结构化输出支持 | runner 接 Zod schema → JsonSchemaOutputFormat，SDK 内置 schema-invalid 重试 | shipped | `src/server/ai/output-format.ts` |
| 流式响应 | streamTask 返回 AsyncIterable，SSE 推前端 | shipped | `src/server/ai/runner.ts` |
| DomainTool 工具体系 | 分层 bounded-write（READ / PROPOSE_WRITE / surface 专属），allowlist 矩阵 | shipped | `src/server/ai/tools/allowlists.ts` |
| 科目技能动态加载 | SDK 从隔离 config dir 加载 SKILL.md，per-task whitelist 选技能，缺包优雅降级 | shipped | `src/server/ai/runner.ts` (populateIsolatedSkills) |

### 2.6 Copilot 对话助手

| Capability | 描述 | 成熟度 | 证据路径 |
|---|---|---|---|
| 自由对话答疑 | 结合错题/知识图谱/今日计划，SSE 流式，有界历史防注入，可选 Tavily 增强 | shipped | `src/server/copilot/chat.ts` |
| 对话持久化与重放 | replay-last-N（默认 20），刷新/重开恢复历史 + active skill | shipped | `src/server/copilot/turns.ts`, `src/ui/copilot/replay.ts` |
| 结构化教学（ask-check） | explain/ask_check/end，ask_check 物化检查题 + 纠正性芯片 | shipped | `src/server/copilot/skills/teaching-skill.ts` |
| 知识 mutation/edge 提议 | propose_knowledge_mutation/edge，仅 propose，proposal_feedback 适配拒绝模式 | shipped | `src/server/ai/tools/allowlists.ts` |
| 题目起草/组卷 | author_question（统一出题）+ write_quiz（组卷，草稿可直接进卷） | shipped | ADR-0031 |
| primary_view hero 呈现 | reply 尾部 marker 提名 hero（artifact/tool_result/ephemeral_html），渲染 ref 卡或内联 iframe | shipped | `src/ui/copilot/CopilotHeroCard.tsx`, `hero.ts` |
| interactive artifact 沙盒 | iframe sandbox（无 same-origin）+ CSP 禁网，威胁模型是 LLM 错写非恶意作者 | shipped | `src/ui/components/InteractiveArtifactRenderer.tsx`, ADR-0033 |
| 上下文感知 + 快速芯片 | ambient_context（route/focused_entity，仅本轮不写 turn），预设快速芯片 | shipped | `src/ui/copilot/CopilotDock.tsx` |
| 学习项生命周期提议 | 用户明确表意时提议 completion/relearn/defer/archive | shipped | `src/subjects/_shared/skills/copilot/SKILL.md` |
| 今日摘要状态 | daily_focus + review_due_count + dreaming_preview + Coach/Dreaming last_run | shipped | `src/server/today/copilot-summary.ts` |

### 2.7 后台异步行为（夜间自审 + 链式管道）

| Capability | 描述 | 成熟度 | 证据路径 |
|---|---|---|---|
| 录入异步解析 | OCR/VLM 后台跑，SSE 推进度，失败重试，原图兜底 | shipped | `src/server/boss/handlers/tencent_ocr_extract.ts` |
| 归因→变式链式 | 错题归因完成自动触发变式生成（fire-and-forget） | shipped | `src/server/boss/handlers/attribution_followup.ts` |
| 知识夜间自审 | 知识点提议(2:00)/边提议(2:30)/Hub 同步(2:45)/维护(3:00)，错峰执行 | shipped | `src/server/boss/handlers/knowledge_*_nightly.ts` |
| Dreaming 综合提议 | 3:15 综合 FSRS 队列+错题+目标+历史反馈，≤5 条建议，goal-aware bias | shipped | `src/server/boss/handlers/dreaming_nightly.ts` |
| Coach 日/周计划 + 复习规划 | 3:45 今日计划 → 链式 ReviewPlanTask 战术出卷；周日 4:30 周总结 | shipped | `src/server/boss/handlers/coach_daily.ts`, `review_plan.ts` |
| 笔记生成链 | 接受意图→note_generate→note_verify→embedded_check_generate | shipped | `src/server/boss/handlers/note_generate.ts` |
| 会话生命周期清理 | 对话 5min idle / 6h orphan 清理，复习 6h orphan 清理，job 事件 7 天清理 | shipped | `src/server/boss/handlers/prune_*.ts` |
| Echo 黄金 E2E | HTTP→worker→DB→SSE 全链路验收门 | shipped | `src/server/boss/handlers/echo.ts` |

### 2.8 科目特化

| Capability | 描述 | 成熟度 | 证据路径 |
|---|---|---|---|
| SubjectProfile 纯数据声明 | 题型/判分路由/笔记模板/错因/渲染/排程/技能，~50 行数据，框架零分支（wenyan/math/physics 已过 acid test） | shipped | `src/subjects/profile-schema.ts` + 各 profile.ts |
| Capability Registry | judge/scheduler 跨学科共享，manifest 供 profile 引用校验，单例注册一次 | shipped/partial | `src/core/capability/registry.ts` |
| 错因分类系统 | 每科 causeCategories（review_priority + variant_targetable），ID 唯一 | shipped | 各 subject profile.ts |
| 题型词表规范化 | 三套词表（持久/profile/skill 目录）单一权威映射，禁手搓特例 | shipped | `src/subjects/question-kind.ts` |
| 分层 Agent Skill 解析 | note-*/quiz-gen-*/copilot 按科目+题型解析白名单，缺包降级散文 | shipped | `src/subjects/note-skills.ts`, `quiz-gen-skills.ts` |
| 学科知识图谱种子 | curriculum.json 定义知识结构骨架 | shipped(wenyan) | `src/subjects/wenyan/curriculum.json` |
| 选题偏好 + 源白名单 | 可信题源域名 + 按题型找题次序（sourced/material/closed_book/variant） | shipped | 各 subject profile.ts |

### 2.9 跨领域基础能力

| Capability | 描述 | 成熟度 | 证据路径 |
|---|---|---|---|
| 统一事件流 | 所有 user/agent/cron/system 动作写 event，因果链 DAG，correction 是唯一撤回机制 | shipped | `app/api/events/route.ts`, ADR-0006 |
| 统一提议收件箱 | 9 种 proposal kind 共享 lifecycle，接受率信号反馈排序 | shipped/partial | `app/api/proposals/route.ts` |
| 完整 AI 审计留痕 | 三张表（ai_task_runs/cost_ledger/tool_call_log）记 lifecycle/成本/工具调用 | shipped | `src/server/ai/log.ts` |
| 全局速率限制 | AI 入口滑动窗口（429）防预算耗尽 | shipped | `app/api/ai/[task]/route.ts` |
| 数据备份恢复 | 导出 DB+R2 为 ZIP；导入 wipe-and-reload（需 confirm）；种子数据 | shipped | `app/api/_/export/route.ts`, `import/route.ts` |
| 今日仪表盘 | KPI（到期/待归因/待审/知识点）+ 进行中会话 + AI 改动（可撤销）+ 成本 + 观察信号 | shipped | `app/(app)/today/page.tsx` |
| Coach 周报 | 7/30/90 天窗口，KPI + 评分/归因分布 + 逐日柱状 + 失败排行 | shipped | `app/(app)/coach/page.tsx` |
| TokenGate 认证 | 单用户，全局拦截 /api/*（除 /api/health），x-internal-token 校验 | shipped | `middleware.ts` |

---

## 3. 横切质量属性与产品不变量（去重合并）

以下是跨所有领域反复声明的硬约束，构成系统的「学习数据宪法」。

### 3.1 核心不变量（红线，任何 feature 不可违反）

1. **单用户无多租户** — 无 per-user auth/隔离/权限切换；所有表无 user_id；仅 x-internal-token 校验（/api/health 豁免）。
2. **AI 行为可追溯可回滚** — 所有 AI 判断/提议写审计表（created_by/generated_by/verified_by + 三张 correlation log）；proposal 机制保证 mutation 可审核可撤销；近 24h 改动可从今日页撤销。最大失败模式不是死板，是**数据失信**。
3. **事件是唯一真实来源** — 所有动作写 event（append-only 不可变）；FSRS 状态、掌握度都是从事件投影的衍生数据，不手工维护；correction event 是唯一撤回机制（supersede/retract/mark_wrong/restore）。
4. **科目是视角不是结构** — 知识树按认知结构生长；subject 经 domain 派生（effective_domain）；按科目查询一律派生轴；**给实体加 subject 列是违例，永远不动树**。
5. **原图必须同步留存** — OCR/VLM 抽取时原图必须同步存 R2，保证 VLM 兜底可行；vision 模型 id 是 mimo-v2.5。
6. **知识图：树是骨架，网是肌肉** — parent_id 主层级，knowledge_edge 叠加 typed 横向边；mesh edge 不存树已表达的边。
7. **写入仅 propose** — Copilot/AI 所有 mutation/edge/learning-item 变更工具均为 propose，需用户 accept 才写入。

### 3.2 AI 能动性边界（分层授权）

- **软判断**（完成判定/推荐/排序/人话总结/quiz 评分）→ AI **自由发挥**。
- **软提议**（删错题/合并节点/归档/状态重置）→ AI 提议 + 用户确认 + 可回滚。
- **硬数据**（错题正确率/复习记录/行为日志/Judgment 历史）→ 事实层**不可改**。
- **不可逆消费**（跨预算 LLM 调用）→ 硬约束（速率限制 + 预算上限）。

### 3.3 一致性与并发

- **FSRS 状态单一真相源** — material_fsrs_state 必须通过 upsertFsrsState 单一入口写入；FSRS state 与 review 事件同事务。
- **乐观锁并发控制** — artifact body_blocks / learning item / question 更新带 version，冲突 409。
- **行锁防重入** — acceptProposal 用 SELECT FOR UPDATE；knowledge_edge UNIQUE(from,to,relation_type)。
- **提案幂等** — 重复决策返回 idempotent=true，状态不跳跃（pending→accepted/dismissed/stale）。
- **派生可见性服务端强制** — visible_to_user 由 paper.plan 派生，客户端不可篡改。

### 3.4 质量门与降级

- **Draft 不进 FSRS** — quiz_gen/sourcing 生成的 draft 不进复习池，verify 通过激活才 FSRS enroll。
- **置信度最弱链原则** — 自动入库置信度 = min(提取置信度, 标注置信度)；任一薄弱转人工。
- **vision 降级协议** — 专用 OCR 默认 → VLM 兜底 → heavy 模式；结构化抽取走确定性 API 不交 LLM。
- **缺 skill 包优雅降级** — resolveNoteSkill/resolveQuizGenSkills/resolveCopilotSkills 返回 undefined 而非报错，回退散文 prompt。
- **SSE 流式降级** — AI 对话 SSE 失败降级为 resolve 完整结果，不丢 turn；支持 Last-Event-ID 断线重放。
- **双 pass 验证** — 变式题/笔记/组卷/题源都有二阶验证，失败保 draft 不污染用户数据。

### 3.5 数据生命周期

- **软删除优于硬删除** — artifact/learning item/record/question/knowledge/knowledge_edge 用 archived_at 软删除。
- **软耦合优于硬约束** — answer/event/artifact 关联字段用 text 软引用，避免级联删除阻塞。
- **两步确认破坏性操作** — 软归档题目、清库重载先返回 409 + 关联计数，带 confirm=true 执行。
- **草稿粒度每空每题** — answer 表粒度 = (session_id, question_id, part_ref)。
- **版本不可变** — question 的 bloodline（source_tier/family/root_id）创建后不可改。
- **异步任务优先** — 耗时操作入 pg-boss，返回 businessId 供 SSE 监听，不阻塞 HTTP。
- **会话状态机** — review/practice/teaching 遵守状态机（created→started→paused→completed/abandoned），非法转换 400；sendBeacon 友好。

### 3.6 防循环注入红线（五层防护）

注入事实非上一轮 prompt 装配物；ambient_context 不写入 turn payload；history 剥离至 {role,text}；proposal_feedback 单向读；agent_notes 双层截断 + expires_at。primary_view marker 不回写 prompt。

---

## 4. Roadmap 压力：文档声明但未实现 / 半实现的功能

> 未来架构必须接得住的方向。按承诺档分组。

### 4.1 B 档（学习意图）— `partial`
- **「我想学 X」proposal flow 三态仅实现 1/3**：3a（主题不存在 → 提议根+子节点）、3b（缺子节点 → 提议 children）未实现，仅 3c（现有图提议 sequence）完整。
- **意图拆解 / 五段式笔记 / 笔记验证 / 自检题生成** 标记 partial — 链路已通但深度待打磨。
- 架构压力：知识树「生长」路径（新建根节点、自动补子节点）必须在不违反「Phase 1a 单域 parent_id 非 null」约束下演进，未来跨域时该约束要松绑。

### 4.2 C 档（AI 主观能动）— `partial`
- **Dreaming deep ranking**：提议生成已 ship，但「深度排序 / acceptance-rate 排序优化」待。
- **Living Note 自动精炼**：标记 scaffold/partial（NoteRefineTask handler 已落但端到端信号触发待验证）。
- **目标范围周期性建议**：goal_scope_propose_nightly 已 ship，但目标驱动的复习偏置深度待。
- 架构压力：提议收件箱排序需接得住「接受率信号 → AI 自适应偏好」的反馈回路扩容。

### 4.3 D 档（一等对等行为体）— `partial`
- **DomainTool Registry 全 21 工具**（13 read + 8 propose/write）— 部分落地，全量仍在建设。
- **CopilotDrawer 跨 6 routes 常驻** — 已落地但覆盖范围待补全。
- **错题归因/变式提议工具** 标记 partial（attribute_mistake/propose_variant chip-only surface）。
- **P3 async tracker 卡** — 设计已定，awaiting 实现（分钟级/扇出 N 的 async pg-boss 逃生口 UI）。
- **YUK-276 tool-use 卡** — claude design 已出稿，awaiting 实现（三段式 ask/tool-use/explain UI）。
- 架构压力：呈现层需「零基础设施新增」复用通用密度杠杆，async tracker 是下一个组合层缺口。

### 4.4 横向能力深化
- **Memory 双层** — Mem0 facts 层（pgvector）+ brief layer（partial）；brief 周期性 refresh 待深化。
- **Capability Registry 调度器** — judge 5/14 类已落（semantic/steps/unit_dimension/multimodal_direct 核心只提供 manifest，真实执行在 server JudgeInvoker）；scheduler 仅 fsrs_question 已落，none_evidence_only/record_recall/practice_cadence/milestone_review/跨学科 scheduling v1 待。
- **Multimodal first-class（G 档）** — VLM 图题空间匹配 + image_candidate 提案兑现，partial。
- **deterministic quotas（I 档）** — maxCost/cost 强制执行 phase-deferred（仅声明不参与执行）；provider fallbackChain 仅声明 metadata，runner 不做 cascade。
- **第 4 学科压力测试** — SubjectProfile 框架零分支已过 wenyan/math/physics，第 4 学科未启动。
- **错题本正解对比** — phase-deferred（无 reference_md 字段，代码注释标注）。
- **题库草稿筛选** — 客户端降级（无后端支持）；题目详情页未实现。

### 4.5 已声明的 Non-Goal（架构不必接）
公共 MCP server / plugin marketplace；多用户 / per-user auth；跨预算 LLM 调度执行；多端原生 app；聊天框形态的 LLM 抽象；自建 tool-calling 循环；抽通用 Tool interface（YAGNI 等第二种 tool kind）。

---

## 5. 数据资产清单（系统长期保管的信息）

> 30+ 类实体，构成「知识图谱 + 事件日志」双核心。按功能含义分组。

### 5.1 认知结构（知识图谱）
| 资产 | 保管内容 |
|---|---|
| **knowledge** | 知识节点：层级 parent_id、domain、合并历史 merged_from、归档状态 |
| **knowledge_edge** | 有向关系边：5 类 typed relation + experimental:*、权重、created_by、reasoning |
| **knowledge_mastery**（视图） | 掌握度：从事件 30d 半衰期派生，不存储 |

### 5.2 原始材料与题目
| 资产 | 保管内容 |
|---|---|
| **source_asset** | 原始文件：storage_key、MIME、SHA256、尺寸、宽高（原图永久留存） |
| **source_document** | 提取文档：Markdown 正文、标题、provenance、source_asset_ids |
| **question_block** | 题目块：page_spans、layout_quality、visual_complexity、置信度、结构化题干、figures |
| **question** | 可练习题目：题干/参考/rubric/选项/难度、knowledge_ids、变体家谱、嵌套子题、judge_kind_override |
| **mistake_variant** | 错题变体生命周期：draft→active→broken，父题/变体题/提案事件、failure_reasons、variants_max=3 |

### 5.3 学习意图、任务与目标
| 资产 | 保管内容 |
|---|---|
| **learning_item** | 学习任务：标题/内容/知识点、source、primary_artifact、父子关系、状态机、ai_score、due_at |
| **completion_evidence** | 完成证据：path、evidence_json、user_overrode_low_evidence、decided_at |
| **goal** | 长期目标（北极星）：标题、scope_knowledge_ids、sequence_hint（不展示）、active/dormant/done |

### 5.4 AI 产物与引用
| 资产 | 保管内容 |
|---|---|
| **artifact** | 统一 AI 产物：type、body_blocks（full/raw/partial 三态）、generation/verification_status、history、tool_state |
| **artifact_block_ref** | 块间引用：cross_link / embedded_check、from/to artifact+block |
| **memory_brief_note** | 记忆简报：per-scope 三窗口 markdown + evidence_ids、long_term_freshness_score |

### 5.5 行为记录与事件
| 资产 | 保管内容 |
|---|---|
| **event** | 统一动作日志：actor_kind/ref、action、subject_kind/id、outcome、payload、caused_by、cost、ingest_at（outbox） |
| **learning_record** | 学习记录：capture_mode、activity_kind、processing_status、各类关联、origin_event_id |
| **answer** | 答题草稿：input_kind、content_md、image_refs、vision_extracted、每空每题粒度、autosaved_at |
| **learning_session** | 学习会话：6 type（ingestion/review/tutor/explore/create/conversation）、状态、summary_md、artifact_id |

### 5.6 调度与衍生状态
| 资产 | 保管内容 |
|---|---|
| **material_fsrs_state** | FSRS 投影：subject_kind（knowledge/question）、state、due_at、last_review_event_id |
| **proposal_signals** | 提案信号：kind、accept/dismiss_count、acceptance_rate、cooldown_until（AI 自适应偏好） |

### 5.7 AI 运维与审计
| 资产 | 保管内容 |
|---|---|
| **ai_task_runs** | 任务运行：task_kind、provider、model、status、usage、cost_usd、起止时间 |
| **tool_call_log** | 工具调用：tool_name、effect（read/propose/write）、input/output、iteration、latency、mirrored_event_id |
| **cost_ledger** | 成本明细：cost、tokens_in/out、outcome、pgboss_job_id |
| **job_events** | 作业事件流：business_table/id、event_type、payload（SSE 推送源，7 天保留） |
| **echo_jobs** | E2E golden master：input/output/status（正确性验收门） |

### 5.8 数据资产层不变量
- 单用户（无 user_id）；原图强制留存（SHA256+storage_key）；AI 写入带 actor 标记；掌握度/FSRS 从事件投影；树永不动（合并保留历史）；草稿每空每题粒度；产物统一 artifact 三态；event 用 ingest_at 做事务性 outbox；成本三层可观测；软耦合（text 软引用）；提案受控（变体在途数限制）；目标不强制抑制；echo_jobs 是 E2E golden master。

---

*文档边界声明：本地图提取的是「文档与代码已声明的产品目标」，成熟度依据各域 status 标记（shipped/partial/scaffold）与 ADR 状态综合判定。仅谈功能目标，未涉及代码架构实现细节。*
---

## 附录 A：完整性批评补查的 8 个遗漏功能区（已并入功能面）

> 初版地图由 11 个域级 agent 提取，完整性批评者抽查后发现以下遗漏，其中前 5 个已派 agent 详查。


### A.1 Agent-notes / cross-agent observation board

AI 代理之间的异步观察信号通道，允许后台任务（quiz_verify、dreaming、coach、maintenance）彼此留下带溯源和过期时间的软提示（hints）。用户通过只读界面旁观这些信号，用于观察 AI 系统的内部协作，无需裁决。信号自动过期消失，唯一持久化状态是用户的本地"已读"标记。这是"AI 作为一等公民"理论的核心基础设施——代理协调代理，而非仅响应用户。

- **跨代理观察信号写入**（shipped）：后台 AI 任务可向其他代理留下观察信号，包含目标代理列表、信号类型（signal_kind）、置信度、引用实体（refs）和过期时间。当前写方只有 quiz_verify（题池缺口检测），未来规划有 attribution、copilot、tagging。 _证据：src/server/agents/notes.ts (writeAgentNote), src/server/boss/handlers/quiz_verify.ts (question_pool_gap signal)_
- **按代理过滤读取**（shipped）：代理可读取发送给自己的未过期观察信号（for_agent 参数），过滤基于 JSONB 包含查询和过期时间戳。读取时标注为「提示非事实」，仅作注意力先验。 _证据：src/server/agents/notes.ts (readAgentNotes), src/server/boss/handlers/dreaming_nightly.ts (agent_notes input)_
- **全局只读观察面板**（shipped）：用户可在 /agent-notes 页面旁观所有 AI 代理之间的观察信号，按信号类型过滤，按时间分组（今天/昨天/更早）。显示来源代理→目标代理路由、信号类型、置信度、过期倒计时、证据链接。 _证据：app/(app)/agent-notes/page.tsx, src/ui/agent-notes/AgentNoteCard.tsx_
- **Today 页面紧凑摘要块**（shipped）：在今日页面显示折叠的 AI 观察摘要块，默认收起，显示最新 3 条信号，未读红点提示（24 小时内新建）， _证据：src/ui/agent-notes/AgentNotesBoard.tsx, app/(app)/today/page.tsx (board 集成点，未直接读取但存在)_
- **本地已读状态管理**（shipped）：通过 localStorage 持久化折叠状态和已读标记，今日页面块和全屏页面共享同一套键值（AN_LS_OPEN、AN_LS_READ）。 _证据：src/ui/agent-notes/useAgentReads.ts, src/ui/agent-notes/derive.ts (isFresh 函数)_
- **信号类型与代理元数据**（shipped）：开放词汇表系统，支持动态扩展 signal_kind（题池缺口、覆盖偏薄、误解模式、质量信号等）和 agent kind（出题校验、错因归因、Copilot、打标、夜间推理、维护、教练）。未知键降级显示为原始文本 + 中性色调。 _证据：src/ui/agent-notes/meta.ts (AGENT_META, SIGNAL_META, agentMeta, signalMeta), src/ui/agent-notes/derive.test.ts_
- **证据链追溯**（shipped）：每条 note 可携带 refs[]（引用实体）和 caused_by_event_id（触发事件链）。UI 支持导航到证据页面（kind='event' 跳转 /events/:id）。refs 空时回退到 caused_by_event_id。 _证据：src/ui/agent-notes/derive.ts (resolveEvidence), src/ui/agent-notes/AgentNoteCard.tsx (证据链接渲染)_
- **过期时间相对化显示**（shipped）：将 expires_at 绝对时间转换为相对文本（「约 N 小时/天后过期」），48 小时内显示为临期警告（琥珀色标签）。 _证据：src/ui/agent-notes/derive.ts (deriveTtl), src/ui/agent-notes/AgentNoteCard.tsx (TTL 渲染)_
- **轻量内联 Markdown**（shipped）：支持粗体（**text**）和行内代码（`code`）两种格式，解析为 React 节点，不引入外部 Markdown 库。未闭合 token 保留为纯文本。 _证据：src/ui/agent-notes/derive.ts (anInlineMd), src/ui/agent-notes/derive.test.ts_

### A.2 Inline editing-session presence + dwell tracking (artifact editing telemetry)

这是一个完整的编辑会话遥测子系统，通过客户端心跳 + 模糊(flush-on-blur)协议追踪用户在 artifact 编辑器中的活跃状态，并将此 presence 信号用作 Living Note 自动优化的触发源之一（dwell trigger），同时驱动 Copilot drawer 的基于停留时间的自动打开行为。系统采用 Redis 跨进程共享 presence 状态（web + worker），确保用户编辑时 AI patch 被推迟直到用户离开编辑器，并支持优雅降级（Redis 故障时读作 idle）。

- **编辑器心跳上报**（shipped）：用户在 artifact 编辑器中活跃时，客户端每 5 秒向 `/api/editing-session/heartbeat` 发送一次 heartbeat，携带 `artifact_id` 和 `status: 'editing'`。系统维护每个 artifact 的 last_heartbeat_at 时间戳和编辑开始时间（editingStartedAt，只在首个 editing heartbeat 打戳，后续不重置），用于判断用户是否仍在编辑。 _证据：app/api/editing-session/heartbeat/route.ts, src/ui/block-tree/ArtifactBlockTree.tsx:194-208 (useEffect heartbeat interval)_
- **超时自动空闲判定（sticky idle-on-timeout）**（shipped）：当最后一个 heartbeat 超过 30 秒（EDITING_HEARTBEAT_TIMEOUT_MS）时，`isArtifactIdle()` 会将 artifact 状态从 editing 就地翻转为 idle（有副作用的读）。这种 sticky transition 会被持久化，后续所有进程（web + worker）都会看到 idle 状态，直到新的 editing heartbeat 到来。 _证据：src/server/artifacts/presence/types.ts:76-78 (isArtifactIdle sticky transition), src/server/artifacts/presence/in-memory.ts:60-70_
- **模糊时立即刷新队列（flush-on-blur）**（shipped）：当用户离开编辑器（blur 事件，如切换标签页、最小化窗口、点击其他区域）时，客户端调用 `/api/editing-session/blur`，触发 `markArtifactIdleAndFlush()`：将 artifact 标记为 idle 并按 FIFO 顺序应用所有被推迟的 AI patch（pending patches），返回 flushed 数量和每条 patch 的应用结果。 _证据：app/api/editing-session/blur/route.ts, src/ui/block-tree/ArtifactBlockTree.tsx:251-257 (markEditorIdle)_
- **强应用上限（force-apply ceiling）**（shipped）：为防止 AI patch 被无限推迟，系统维护 editingStartedAt 时间戳（只在首个 editing heartbeat 打戳）。当持续编辑超过 10 分钟（EDITING_FORCE_APPLY_TIMEOUT_MS）时，即使 heartbeat 仍在活跃，`enqueueOrApplyNoteRefinePatch()` 也会强制应用 patch，不再推迟。 _证据：src/server/artifacts/presence/types.ts:10-12 (EDITING_FORCE_APPLY_TIMEOUT_MS), src/server/artifacts/presence/in-memory.ts:72-78 (shouldForceApply)_
- **跨进程 presence 共享（Redis-backed）**（shipped）：web 进程（接收 heartbeat）和 pg-boss worker 进程（处理 Living Note 任务）共享同一个 Redis 存储的 presence 状态。每个 artifact 的状态存在一个 Redis key（`editing:<artifactId>`），含 status、lastHeartbeatAtMs、editingStartedAtMs、pending[]，通过 Lua 脚本原子化执行复合操作（heartbeat、idle-check、defer/apply 决策、flush）。无 REDIS_URL 时回退到进程内 Map（dev + fast unit tests 默认）。 _证据：docs/adr/0023-cross-process-editing-presence-via-redis.md, src/server/artifacts/editing-session.ts:29-33 (getPresenceStore factory)_
- **Redis 故障优雅降级**（shipped）：RedisPresenceStore 的每个方法都将 ioredis 调用包在 try-catch 中，连接失败时返回 fail-safe 默认值并单次 warn，不 throw：isArtifactIdle → true（读作 idle），recordEditingHeartbeat → no-op（丢的 heartbeat 等价于 timeout），enqueueOrApply → 降级到 APPLY（执行 DB 写，patch 不丢失），markArtifactIdleAndFlush → 返回 {flushed: 0}（不臆测 drained 列表，pending 留在 Redis 待下次重试）。 _证据：src/server/artifacts/presence/redis.ts:201-231 (warnDegraded + failure handling per method), docs/adr/0023-cross-process-editing-presence-via-redis.md:84-100 (YUK-171 graceful degradation)_
- **停留触发 Living Note 优化（dwell trigger）**（shipped）：dwell 是 Living Note v0 的 5 大触发器之一（mark_wrong/mastery_change/error_rate/dwell/dreaming）。当用户在编辑器中活跃（editing heartbeat）时，heartbeat route 会调用 `enqueueDwellNoteRefine()`，向 note_refine 队列投递任务，携带 context 'User is dwelling in the editor; consider whether a small clarity patch would help.'。触发器受 60 分钟去重（NOTE_REFINE_TRIGGER_DEBOUNCE_MS）和环境开关（WAVE6_TRIGGER_DWELL_ENABLED）控制。 _证据：app/api/editing-session/heartbeat/route.ts:28-30 (enqueueDwellNoteRefine on editing), src/server/artifacts/note-refine-triggers.ts:123-132 (enqueueDwellNoteRefine)_
- **Copilot drawer 停留自动打开**（shipped）：Copilot drawer 有一个基于用户行为的 dwell 计时器（默认 30 秒）：首次访问时，如果 30 秒内无交互（鼠标移动、键盘、滚动、点击），drawer 会自动浮出打开；再次访问时直接打开（localStorage 记录 visited 标志）。交互会重置计时器。用户手动关闭后当前 session 不再自动打开。 _证据：src/ui/lib/use-copilot-dwell.ts:104-156 (useCopilotDwell hook), src/ui/lib/use-copilot-dwell.ts:31-32 (COPILOT_DWELL_DEFAULT_MS = 30s)_
- **编辑会话快照查询**（shipped）：提供 `getEditingSessionSnapshot(artifactId)` 接口，返回当前 artifact 的编辑会话状态快照：status（editing/idle）、last_heartbeat_at（ISO 时间戳）、pending_patches（待应用的 patch 数量）。用于诊断和监控。Redis 实现通过 SNAPSHOT_LUA 脚本读取 key，in-memory 实现直接从 Map 读取。 _证据：src/server/artifacts/presence/types.ts:89-90 (getEditingSessionSnapshot), src/server/artifacts/presence/in-memory.ts:125-134_
- **跨树打开 Copilot 信号传递**（shipped）：Copilot drawer 的 dwell 状态是组件局部的，其他子树（如 learning-items/[id] 的「对话教学」按钮）无法直接触发 drawer 打开并传入 skill context。通过一个模块级 Zustand store（CopilotOpenSignal）携带跨树信号，包含单调递增的 seq（防重放）、skill_context（要启动的 skill）和可选的 prefill（自动发送的消息）。 _证据：src/ui/lib/use-copilot-dwell.ts:42-84 (CopilotOpenSignal store), src/ui/lib/use-copilot-dwell.ts:86-93 (openCopilotWith helper)_

### A.3 Embedded-check inline attempt loop (out-of-FSRS micro-checks)

调研了嵌入式题目作答循环的实现。这是与 FSRS 复习和纸质练习并行的第三种练习循环：用户回答笔记中嵌入的题目（embedded_check 块），系统立即判断对错；答错时自动记录为 mistake 并触发归因流程，但不写入 FSRS 状态。同时，系统计算该笔记的错题率，超过阈值时触发 Living-Note 精化任务。所有作答写入 learning_record 用于追溯，但与复习调度完全隔离。

- **嵌入式题目作答循环**（shipped）：用户可以回答笔记中嵌入的题目（embedded_check 块），系统立即判断对错。答错时自动记录为 mistakes 并触发后续归因流程，但不写入 FSRS 复习状态。这是独立的微型自测循环，区别于间隔复习和纸质练习。 _证据：app/api/embedded-check/attempt/route.ts, src/server/artifacts/note-refine-triggers.ts_
- **答错错题记录与归因队列触发**（shipped）：嵌入式题目答错时，系统自动创建 kind='mistake' 的 learning_record 并插入 mistakes 表，同时向 attribution_followup 队列写入任务（pg-boss），启动后续归因流程。这是唯一不通过 /api/mistakes 直接创建 mistake 的路径。 _证据：app/api/embedded-check/attempt/route.ts, src/db/schema.ts_
- **错题率 Living-Note 精化触发**（shipped）：嵌入式题目作答后，系统计算该笔记的错题率（错误次数/总作答次数），若超过阈值（errorRateThreshold，默认 0.5）则触发 Living-Note 精化任务（error-rate-high），让 AI 优化讲解。 _证据：src/server/artifacts/note-refine-triggers.ts, src/core/events.ts_
- **作答历史记录（不含 FSRS）**（shipped）：每次嵌入式题目作答都写入 embedded_check_attempts 表（learning_record），记录题目 ID、用户答案、正确性、时间戳，但不写 FSRS 的 review_logs。历史记录可用来计算错题率、展示自测轨迹，但不影响间隔复习调度。 _证据：src/db/schema.ts, app/api/embedded-check/attempt/route.ts_

### A.4 Admin observability UI surfaces

分析完成。该领域包含一套完整的操作员可观测性界面，涵盖 AI 任务运行、成本监控、失败分类和科目注册表检查。四个核心页面（Runs、Cost、Failures、Subjects）通过专用 (admin) 路由组和共享布局提供实时数据监控和历史分析。

- **AI 运行列表与时间线视图**（shipped）：显示最近 100 条 AI 任务运行记录（可按状态/task 类型过滤），展示任务类型、状态、成本、工具调用数和开始时间。选中单条记录后显示完整时间线，串联 run_started、tool_call、cost_ledger、run_finished 四类事件，暴露 pg-boss job ID、延迟、token 消耗和成本明细。 _证据：app/(admin)/admin/runs/page.tsx, src/ui/admin/observability.tsx:AdminRunsSurface_
- **成本趋势仪表板**（shipped）：展示最近 30 天（可配置）的日成本条形图和按 task kind 聚合的成本排名，显示每日/每任务的美元金额、token 消耗（in/out）和调用次数。数据每 60 秒自动刷新。 _证据：app/(admin)/admin/cost/page.tsx, src/ui/admin/observability.tsx:AdminCostSurface_
- **失败聚类排行榜**（shipped）：按 finish_reason 和错误消息前缀（80 字符）聚类失败样本，展示每个聚类的重复次数、最新发生时间和最多 5 条样本记录（含 run ID、task 类型、模型、开始时间）。最多显示 200 条失败记录的聚类结果。 _证据：app/(admin)/admin/failures/page.tsx, src/ui/admin/observability.tsx:AdminFailuresSurface_
- **科目注册表只读检查器**（shipped）：显示已编译 SubjectProfile 的轻量投影（ID、显示名称、版本、notation、能力数量），直接从 SubjectRegistry 读取（无数据库依赖）。界面复用 observability 视觉风格但保持为纯 RSC（无客户端状态）。 _证据：app/(admin)/admin/subjects/page.tsx, src/ui/admin/subjects.tsx:AdminSubjectsSurface_
- **Admin 共享导航与布局**（shipped）：提供统一的 admin 导航栏（Runs、Cost、Failures、Subjects 四个入口）、TokenGate 客户端认证门（基于 localStorage 的 INTERNAL_TOKEN）和版本标识（"admin · YUK-41"）。所有页面共享 wide 布局和刷新按钮。 _证据：app/(admin)/layout.tsx, src/ui/components/TokenGate.tsx_

### A.5 Theme / Display Preferences

The Loom app shell implements a complete theme and display preference system for a single-user, self-hosted learning tool. The system provides light/dark/auto theme switching with persistent localStorage storage and a no-FOUC (Flash of Unstyled Content) boot script, plus a collapsible navigation rail for desktop layout optimization.

- **主题切换（淡/深/auto）**（shipped）：用户可以在淡色（light）、深色（dark）、自动（auto）三种主题模式间循环切换。淡/深模式强制固定主题，auto模式跟随系统prefers-color-scheme。主题选择通过localStorage持久化，刷新页面后保持。 _证据：src/ui/primitives/ThemeToggle.tsx, app/(app)/layout.tsx_
- **无闪烁主题启动（No-FOUC boot）**（shipped）：在React水合前，通过根layout的内联同步脚本读取localStorage并提前设置data-theme属性，避免首次渲染与真实主题不一致造成的视觉闪烁。 _证据：app/layout.tsx_
- **侧栏折叠/展开（Rail collapse）**（shipped）：桌面端可折叠左侧导航栏为窄轨模式，只显示图标隐藏文字标签，节省屏幕空间。折叠状态通过localStorage的'loom-rail'键持久化。 _证据：app/(app)/layout.tsx, src/ui/shell/AppSidebar.tsx_
- **移动端侧栏抽屉（Mobile drawer）**（shipped）：移动端（≤720px）侧栏默认隐藏，点击顶部菜单按钮或底部「更多」标签以遮罩抽屉形式滑出，点击遮罩或导航项后自动关闭。抽屉打开时启用焦点陷阱（focus trap）和ESC键关闭。 _证据：app/(app)/layout.tsx, src/ui/shell/AppSidebar.tsx_
- **底部导航栏（Mobile tab bar）**（shipped）：移动端显示固定底部的5个核心入口（今日、复习、录入、知识、更多），点击「更多」打开侧栏抽屉访问全部导航。仅在小屏幕（≤720px）通过media query显示。 _证据：src/ui/shell/MobileTabBar.tsx, src/ui/shell/nav-config.ts_

### A.6 Authenticated asset/image content serving from R2（未详查，批评者描述）

The map covers upload + content-addressed storage (assets POST, r2.ts) but not the read/serve side: a dedicated route streams raw asset bytes back through the app (NOT via presigned R2 URLs) specifically to keep the single-user secret server-side while the browser renders source images in the vision-review and question-figure UIs. This 'never expose R2 directly, proxy bytes behind the token gate' decision is an architectural invariant about how the only binary-serving path works, and it is absent from the map.

_线索：/Users/yukoval/yukoval-projects/the-learning-project/app/api/assets/[id]/content/route.ts; /Users/yukoval/yukoval-projects/the-learning-project/app/api/question-blocks/[id]/figures/[asset_id]/route.ts; getR2 in src/server/r2.ts_

### A.7 Judge correction lifecycle: appeal/rejudge + manual ingestion rescue/revert + backfill（未详查，批评者描述）

Several user-facing recovery/correction operations are missed or under-stated. (1) Review appeal: a learner can contest a judge verdict, which writes an experimental:appeal_request event chained to the judge event (rejudge itself is explicitly phase-deferred) and a judge-retraction proposal — the map only says '判错可申诉' in one cell without noting it is a stub that does not rejudge. (2) Manual Vision rescue: the review UI lets the user pick a specific OCR block and force a Tier-2/3 Vision re-extract synchronously (extract / restructure_cloze / restructure_compound strategies). (3) Auto-enroll revert: reverting a WorkflowJudge auto-enrolled block back to draft. (4) Manual nightly backfill/re-run endpoints. These constitute a 'human correction & re-run' capability cluster the map does not name.

_线索：/Users/yukoval/yukoval-projects/the-learning-project/app/api/review/appeal/route.ts (appeal stub, rejudge deferred); /Users/yukoval/yukoval-projects/the-learning-project/app/api/ingestion/[id]/rescue/route.ts (manual Vision tier rescue + strategies); /Users/yukoval/yukoval-projects/the-learning-project/app/api/ingestion/[id]/revert/route.ts (revert auto-enroll); /Users/yukoval/yukoval-projects/the-learning-project/app/api/_/backfill/knowledge_propose/route.ts; /Users/yukoval/yukoval-projects/the-learning-project/app/api/review/sessions/[id]/reopen/route.ts_

### A.8 Legacy/deprecated route gone-stubs and redirects (migration surface)（未详查，批评者描述）

A small but real piece of product behavior the map omits: deliberate deprecation shims. /study-log page hard-redirects to /record, and /api/study-log returns HTTP 410 Gone with a {replacement:'/api/records'} body — an intentional, documented migration contract (the nav still lists study-log in TITLES/PATH_ACTIVE for breadcrumbs). Likewise the (admin) group and _-prefixed dev routes are excluded from the prod build by the '_' marker convention. An architecture map that drives future work should know which surfaces are tombstones vs live, otherwise it risks re-planning already-retired features.

_线索：/Users/yukoval/yukoval-projects/the-learning-project/app/(app)/study-log/page.tsx (redirect to /record); /Users/yukoval/yukoval-projects/the-learning-project/app/api/study-log/route.ts (410 gone body); src/ui/shell/nav-config.ts (study-log still in TITLES/PATH_ACTIVE); the '_'-prefix prod-exclude convention noted in app/api/_/tools/[name]/route.ts_
---

## 附录 B：可维护性诊断证据（为「是否值得重设计」提供事实依据）

> 结构诊断 agent（opus）逐条核验文件与行数；git 热点数据已由主 session 本地重跑验证。


### B.1 支持「难以维护」的发现

- **[high] Proposal dispatch is a single 2151-line file with a 1441-line god-function fanning out to 22 case branches**
  - 证据：src/server/proposals/actions.ts is 2151 lines (the largest non-test file in the repo). acceptAiProposal() spans lines 524-1965 (~1441 lines), driven by a switch on proposal.kind at line 573 with sibling/nested switches at 1174, 1984, 2086. grep counts 22 `case '<kind>':` branches across the file (knowledge_node, knowledge_mutation, knowledge_edge, variant_question, learning_item, completion, relearn, note_update, record_links, record_promotion, goal_scope, block_merge, image_candidate, question_draft, ...). Inline comments at 370-379, 1532-1556, 1637, 1823 each guard a different kind's idempotency/rubric/merge semantics inside the same function body.
  - 影响：每加一种 proposal kind 都要回到这同一个 1441 行函数里塞一个 case + 它自己的 idempotency/rubric/事务规则，多种语义在一个作用域里缠绕。新功能的 reviewer 必须读完整个 switch 才能确认没破坏其他 kind 的不变式；测试要 mock 整条 accept 路径才能覆盖一个分支。这是继续添加 proposal 类型时最直接的摩擦点。
- **[med] AI capability surface concentrates in 2-3 central files that every new feature must edit (high churn coupling)**
  - 证据：git log (90d) commit counts per source file: src/ai/registry.ts = 61 commits, src/ai/task-prompts.ts = 45, src/db/schema.ts = 34, src/core/schema/business.ts = 27, src/server/boss/handlers.ts = 26. registry.ts holds one monolithic `tasks = {...}` object (line 58) where each AI task is a ~30-line inline literal (file is 756 lines); task-prompts.ts is 941 lines of per-task prompt builders. Both are the single hottest files in the repo by edit frequency.
  - 影响：新增/调整任一 AI 能力都强制改这几个中心文件，制造 merge-contention 与 review-blast-radius：多条 lane 并行时几乎必撞 registry.ts/task-prompts.ts/schema.ts。inline 大对象 + 大 prompt 字符串让 diff 难读、难按能力隔离测试。这是一个'每个 feature 都过同一个收费站'的结构，随能力数量线性恶化。
- **[med] Unit/db test partitioning rests on a 112-entry hand-maintained allowlist with silent-failure modes baked in**
  - 证据：vitest.shared.ts is 309 lines; fastTestInclude is a hand-written allowlist with 112 explicit `'<path>.test.ts'` entries, each often carrying a multi-line justification comment (e.g. lines 48-55 explain why two specific files are unit-safe). The file's own header (lines 20-29) documents the trap: a `.test.tsx` matching no glob 'lands in NEITHER vitest config ... → a silent green non-run.' Three vitest configs (unit 18 / db 54 / migration 18 lines) plus this shared file, plus scripts/audit-test-partition.ts (8.5KB) exist solely to lint that the allowlist hasn't drifted (P0 = test in fast list but imports DB unmocked → runtime crash).
  - 影响：每写一个 unit test 都要记得手动加进 112 条 allowlist，否则它静默掉进 db 分区或完全不跑（绿但没执行）。这套约束（3 configs + shared + audit:partition lint）是为了防一个本可由约定/目录结构解决的问题而长出的脚手架；它的维护成本由每个写测试的人持续承担，且失败模式是'静默通过'——最危险的那种。
- **[med] App router has 15 route handlers and 6+ page components over 400 lines, with the heaviest pages mixing fetch/state/render**
  - 证据：wc -l: app/(app)/knowledge/page.tsx=1313, review/page.tsx=1059 (15 useState + 8 useEffect), practice/[id]/page.tsx=1023 (6 useState + 8 useEffect), today/page.tsx=925 (5 raw fetch calls), record/page.tsx=864 (18 useState), learning-items/[id]/page.tsx=869. On the API side: app/api/review/submit/route.ts=532, ingestion/[id]/import/route.ts=529, learning-items/[id]/route.ts=519. Route size distribution: 50 thin (<50L), 43 mid, 15 fat (>150L).
  - 影响：1000+ 行、18 个 useState 的页面（record/page.tsx, review/page.tsx）把数据拉取、本地状态机、和渲染全揉在一个组件里，改一处交互要在巨大的组件里定位状态来源。fat route（submit 532行）把校验+判分+写库内联，回归面大。继续给这些页面加 feature 时，认知负荷和误改风险随行数上升。
- **[low] Governance/documentation surface is very large relative to a single-user tool: 111 AGENTS.md, 32 ADRs, 196 plans/specs, 26 drift audits**
  - 证据：find counts: 111 AGENTS.md files, docs/adr=32 ADRs, docs/superpowers/plans+specs=196 markdown files, docs/audit=26 reports (latest 2026-06-08), docs total 346 .md. CLAUDE.md mandates running 4 audit scripts (audit:schema/partition/profile + audit-drift skill) plus a Linear-issue-capture gate before every implementation's final response, plus per-route Postman regeneration (postman/api-endpoints.json + gen:postman).
  - 影响：决策上下文分散在 111 个 AGENTS.md + 196 plans/specs 里，新增功能前要在多处文档对齐（pre-flight 引用 design doc、更新 module doc、ADR、Postman、Linear）。这套流程保证了可追溯性但抬高了每个改动的固定开销；对继续添加功能而言是'每次都要付的税'，不是代码腐烂，但确实是维护成本信号。

### B.2 反证（架构健康的部分）

- **Module boundaries are clean: every cross-layer import is type-only or test-only, no value-level leakage**
  - 证据：grep across layers: src/server imports from src/ui = 0. src/ui imports from src/server = 3 files, ALL `import type` (CopilotDock.tsx:32, use-copilot-dwell.ts:27, PaperCard.tsx:10). The 2 client components in app/ that import @/server (practice/page.tsx:13, practice/[id]/page.tsx:27) are both `import type` (no server code bundled to browser). src/core leaking to server/ui = 0; the 5 core→subjects imports are 4 test files + 1 type import (validate-profile.ts:6). src/subjects→src/server = 4 entries, all test fixtures.
- **Shared logic is genuinely centralized, not copy-pasted: error handling, data fetching, and propose-services are reused**
  - 证据：Route error shaping: 99 imports of @/server/http/errors across app/api, only 1 raw `NextResponse.json({error})` — errors funnel through one helper. Data fetching: 19 app pages use useQuery/useSWR (TanStack Query), 0 pages use raw `await fetch` for data. Propose tool layer delegates rather than duplicates: proposeKnowledgeEdgeTool (proposal-tools.ts:489) calls execute fns that import the same shared services actions.ts uses — @/server/proposals/writer (writeAiProposal), @/server/knowledge/rubric-validator, @/server/proposals/inbox. AI tasks register through one declarative `tasks` object, not per-task scattered registration.
- **Existing drift audits conclude code-vs-ADR alignment is healthy; the real risk lives in new design docs over-producing tables/tasks**
  - 证据：docs/audit/2026-05-30-drift.md concludes the only actionable item is a roadmap-vs-validator coverage gap (roadmap claims 7 invariants, validator checks ~4) and explicitly states 'not an ADR↔code contradiction'; all 3 profiles pass audit:profile (invalid:0 warnings:0). docs/audit/2026-06-04-design-feasibility-audit.md's 30 verified findings target THREE unmerged design docs (CO/PS/AF) for premature abstraction — e.g. CO proposes knowledge_review_state table that 'reverses a same-day-locked TDM decision' and PS builds '4 DB tables + 4 agent tasks + 7-tab UI for 3 static 1.0.0 profiles' — i.e. proposed but not-yet-built scope creep, caught before merge.

### B.3 本地验证的 90 天 git 热点（2026-06-10 重跑）

| 文件 | 90d 提交数 |
|---|---|
| app/globals.css | 86 |
| src/ai/registry.ts | 61 |
| src/ai/task-prompts.ts | 45 |
| src/db/schema.ts | 34 |
| src/core/schema/business.ts | 27 |
| src/server/boss/handlers.ts | 26 |
| src/server/copilot/chat.ts | 23 |
| app/(app)/today/page.tsx | 23 |
| app/api/review/submit/route.ts | 22 |

fix/revert 提交占比：223 / 935 ≈ 24%。


### B.4 诊断结论（原文）

用户「现有架构难以继续维护」的判断部分成立，但需要精准定位——问题不是模块边界乱或逻辑到处复制（这两点经检验是健康的），而是少数中心文件过度集中 + 测试脚手架的手工 allowlist 维护成本。

支持判断的可验证证据：(1) src/server/proposals/actions.ts 2151 行，其中 acceptAiProposal() 一个函数 1441 行、switch 22 个 proposal kind，每加一种都得回这个函数塞 case + 自带不变式（high）；(2) AI 能力面集中在 registry.ts(90天61次提交)/task-prompts.ts(45)/schema.ts(34)，每个新 feature 都过这几个'收费站'，并行 lane 必撞（med）；(3) unit/db 分区靠 vitest.shared.ts 里 112 条手写 allowlist，文件自陈失败模式是'静默绿色不执行'，外加 3 个 vitest config + audit:partition lint 只为防这套 allowlist 漂移（med）；(4) 6+ 个页面组件 >800 行、record/page.tsx 18 个 useState，fetch/state/render 揉在一起（med）；(5) 治理面庞大：111 AGENTS.md + 32 ADR + 196 plans/specs + 26 drift 报告，每次改动固定开销高（low）。

反驳判断（架构其实健康的部分）：层间依赖方向干净，所有跨层 import 都是 type-only/test-only，无运行时越界——骨架健康，可安全按层拆大文件；共享逻辑真的复用了（route 错误处理 99 处走 @/server/http/errors 仅 1 处裸写；19 个页面用 TanStack Query 0 个裸 fetch；propose tool 委托给共享 service 不重写）；已有 drift 审计结论是 code-vs-ADR 漂移很小，真正风险是新 design doc 的过度造表/造 task，而这已被审计流程拦截。

结论：可维护性痛点是'中心文件过胖 + 测试脚手架手工债'，不是'架构腐烂'。修法是拆分热点文件（actions.ts 按 kind 拆 handler、registry/prompts 按能力拆），而非去重或重画模块图。所有路径均为绝对路径下的具体文件，证据可复核。
