# Sub 0c · Handoffs & Roadmap

Sub 0c brainstorm（2026-05-11 grill）期间显式延后的事项，按下游 Sub 归类。后续工作者 / agent 应当用这份文档作为"Sub 0c 承诺过的债务清单"，不需要再回溯整段对话。

每条延后项标注：
- **From**: 哪个决策 / ADR / spec 段落产生
- **To**: 哪个 Sub / 触发条件
- **Status**: queued（已写入 roadmap）/ deferred-conditional（无明确触发不做）

---

## 1. Sub 0b2（UI 重做 · Loom design v1）

| 工作 | From | Status |
|---|---|---|
| SSE 集成 UI（实时状态 / 进度条 / 失败重试按钮） | Sub 0c spec § 1.2 SSE-as-SoT | queued |
| Rescue 触发按钮（用户手动调 Tier 2/3 Vision） | ADR-0002 + Sub 0c § 1.6 rescue endpoint | queued |
| Figure 重归属交互（拖拽 / 下拉选目标题号） | Sub 0c § 1.7.1 (c) | queued |
| 低置信度配图视觉标识（`attach_confidence === 'low'` → 红框 + tooltip） | Sub 0c § 1.7.1 (c) | queued |
| `layout_quality === 'partial' \| 'text_only'` 时 UI 提示走 rescue | Sub 0c § 1.6 layout quality + ADR-0002 修订段 | queued |
| 用户手输 / 编辑错答（覆盖 / 补充 extraction_evidence.handwriting） | Sub 0c § 1.7 extraction_evidence 留给手动覆盖路径 | queued |
| Tencent 内置判分（tencent_grading）的展示方式 —— 仅显示还是参与高亮 | ADR-0002 修订段 | queued |
| 完形填空 / 阅读理解的多 sub 渲染（stem passage + N 个 sub 卡片） | Sub 0c § 1.7 stem/sub 树型 | queued |
| 账号欠费（`ResourceUnavailable.InArrears`）的专门错误页 | Sub 0c § 7 risks | queued |

---

## 2. Sub 0z（NAS 部署 bootstrap）

| 工作 | From | Status |
|---|---|---|
| Dockerfile multi-stage（base = `node:24-bookworm-slim`，**自带 libvips 支持 sharp**） | Sub 0c § 7 risks | queued |
| `docker-compose.yml`：app + worker + postgres:16-alpine + cloudflared 四服务 | Sub 0c § 1.1 + § 7 risks | queued |
| worker 服务 `command: ["node", "dist/scripts/worker.js"]`；app 服务 `next start` | Sub 0c § 1.1 | queued |
| Cloudflare Tunnel SSE 验收：发送测试事件，确认无 buffer（`X-Accel-Buffering: no` 生效） | Sub 0c § 7 risks | queued |
| 移除 `.vercel/` 残留 artifacts；`package.json` 删 Vercel-specific scripts | Sub 0a 后续遗留 | queued |
| `DATABASE_URL` 切到 NAS 本地 PG；`.env` 模板更新 | Sub 0c § 1.1 + Sub 0a 后续 | queued |
| pg-boss 跟 NAS PG `max_connections=100` 配置验证（13 连接占用） | Sub 0c § 1.5 连接池表 | queued |
| docker volume：postgres 数据 + R2 缓存（如有） | Sub 0z 独立设计 | queued |
| 容器健康检查 / 重启策略：`restart: always` for worker；app 走 next 自身 | Sub 0c § 1.1 graceful shutdown | queued |
| 部署文档：NAS 启动顺序（先 PG → migration → app+worker），首次部署 checklist | Sub 0z 独立设计 | queued |

---

## 3. Sub 1（Capture Pipeline Rebuild · Phase 1b 主线）

### 3.1 任务 / handler 实现

| 工作 | From | Status |
|---|---|---|
| **JudgeTask** 完整 handler（输入 sub + 用户答案 + 参考答案 → 判分 / 错误细节） | Sub 0c § 1.4 scope 排除；ADR-0002 修订段 | queued |
| **StructureTask**（如需）—— Tencent 输出后的二次结构化（特殊题型 / 表格 / 公式拆分） | Sub 0c spec § 9 + architecture-review Q1 | queued |
| **AttributionTask** 重构 —— 适配新 structured + extraction_evidence 输入 | architecture-review Q3 + Sub 0c § 1.7 | queued |
| **SessionSummaryTask** —— 会话结束时 LLM 总结 | architecture-review Q1 | queued |
| **TaggingTask** —— 知识点自动标注（与 Tencent KnowledgePoints evidence 互校） | architecture-review Q2 | queued |
| **WorkflowJudge async lane** —— 多步判分（含 vision-augmented judging） | architecture-review Q2 | queued |
| **MistakeEnrollTask** —— `question_block` → `question` + `mistake` 推进 | architecture-review Q3 | queued |

### 3.2 领域工具集（修改 StructuredQuestion 的 type-safe 入口）

| 工作 | From | Status |
|---|---|---|
| `updatePrompt(block_id, structured_index, new_text)` | Sub 0c § 1.7 修改约束 | queued |
| `addOption(block_id, structured_index, label, text)` | 同上 | queued |
| `removeOption(block_id, structured_index, label)` | 同上 | queued |
| `updateAnswer(block_id, structured_index, answer_idx, new_text)` | 同上 | queued |
| `setQuestionType(block_id, structured_index, type)` | 同上 | queued |
| `reassignFigure(...)` 升级为 agent-callable 工具（包装 Sub 0c 的 PATCH endpoint） | Sub 0c § 1.7.1 (b) | queued |
| `splitStem(...)` / `mergeQuestions(...)` —— compound 边界调整 | 推测需求 | queued |
| AI SDK tool definitions 包装上述函数（让 LLM 可调用） | Sub 0c § 1.10 + ADR-0003 修改约束 | queued |
| `structuredToContextualPrompt(stem, sub)` helper（前置注入 passage） | Sub 0c § 1.7 LLM 调用方约定 | queued |
| `structuredToReferenceMarkdown(s)` 完整实现（含 tencent_grading evidence 优先） | Sub 0c § 1.7 派生函数 | queued |

### 3.3 数据流细化

| 工作 | From | Status |
|---|---|---|
| `question_block` → `question` + `mistake` 推进规则（用户确认抽取后） | Sub 0c §9 out of scope | queued |
| Tencent 内置判分 vs JudgeTask 双源时的对账逻辑（不一致时如何告警） | ADR-0002 修订段 evidence-only 原则 | queued |
| 用户错答抽取后 → `mistake.wrong_answer_md` / `wrong_answer_image_refs[]` 自动填充 | Sub 0c §9 已捕获，未流转 | queued |
| Tencent Angle != 0 旋正预处理（在调 Submit 之前自己旋图） | Sub 0c § 1.6 角度处理 | queued |
| 多页 PDF 内的 compound 跨页（stem 在 p1，subs 在 p2）合并逻辑 | Sub 0c 默认未支持 | queued |

---

## 4. 触发条件式（无明确时间表，看用量）

| 工作 | From | 触发条件 |
|---|---|---|
| AI provider factory 完整实现（OpenRouter / Gateway 分支） | ADR-0003 | 跨模型评测 / 非 Anthropic 模型实验 / Anthropic 事故 / 合规顾虑（任一） |
| Python sidecar 容器 | ADR-0001 | 需要本机跑模型权重 / pandas-numpy 级数据处理（任一） |
| pg-boss → 其它队列引擎迁移 | Sub 0c § 1.1 | pg-boss 并发 / 性能撞墙（个人工具不太可能） |
| R2 配图 GC（rescue 重写后旧 figures 删除） | Sub 0c § 1.6 default-keep | R2 存储成本撞预算（单用户工具不可能） |
| Figure role 细分（chart / illustration / photo / formula） | Sub 0c § 1.7 默认 'diagram' | UI / LLM 需要按类型差别处理时 |
| 老 ingestion sessions OCR / mistake backfill | Sub 0c § 1.8 cron first-run | 用户主动需求；`POST /api/_/backfill/knowledge_propose?since=...` |
| Tencent 内置判分阈值化触发 JudgeTask（仅判分不一致时跑） | ADR-0002 修订段 | Cost 优化时；当前每个 sub 都跑 JudgeTask |
| 跨题 / 跨试卷的 mistake-知识点关联挖掘（dreaming lane 升级） | architecture-review Sub 8 | Phase 1b 后期 |
| Variants gen（同质题批量派生） | architecture-review Sub 5 | Phase 1b 后期 |

---

## 5. 更远（Sub 2-9，对齐 architecture-review.md）

| Sub | 名字 | 简述 | 依赖 |
|---|---|---|---|
| Sub 2 | 多学科 + knowledge_link | subject 根节点 + tree migration + knowledge_link CRUD | Sub 1 |
| Sub 3 | Quiz Render UI | kind-switched render + reading parent + image render + `/api/assets/:id/blob` | Sub 1 |
| Sub 4 | StudyLog | 最小 CRUD | 无强依赖 |
| Sub 5 | Variants gen（Maintenance lane） | weekly cron batch | Sub 1 + Sub 3 |
| Sub 6 | Source layer（Exa） | quiz 拿外部题源 | Sub 3 |
| Sub 7 | Orchestrator Agent | Layer 2 + agent_session + multi-turn | Sub 1-6 多数 |
| Sub 8 | Dreaming lane（daily cron） | DreamingProposeTask + MasteryAdjustTask + log | Sub 1 + Sub 2 |
| Sub 9 | Maintenance lane（weekly cron） | MaintenanceReviewTask + VariantsGen batch | Sub 5 |

详细分解见 `docs/superpowers/specs/2026-05-11-architecture-review.md` § 路线图。

---

## 6. Sub 0c 本身遗留（spec 里未充分定义的小决策）

这些是 spec 写到一半发现"现在不重要、Sub 0c 时再定即可"的小问题，写下来防止落地时漏掉：

| 小决策 | 何时决定 |
|---|---|
| `RetryableError` / `PermanentError` 是 throw class 还是返回的 result tagged union | Sub 0c plan 拆分时（实现细节，10 分钟选） |
| SSE in-memory router 在 app 多实例（未来横向扩展）时的协同方案 | 不在 Sub 0c 范围；单实例假设下不存在问题 |
| `job_events` 表的索引策略（除 `(business_table, business_id, id)` 外是否需要 `occurred_at` 索引） | Sub 0c 实现时按实际查询压力决定；先建主索引 |
| MSW mock fixture 的版本管理（Tencent 响应 shape 演进时如何更新 fixture） | 维护问题，遇到再说 |
| pg-boss `archiveCompletedAfterSeconds` 默认值是否够（7d） | Sub 0c 初期保持默认；如 `/api/_/logs/jobs` 查询出问题再调 |
| Worker 进程数（docker-compose 起 1 个还是多个 worker 容器） | Sub 0z 决定；单用户默认 1 个 |

---

## 7. Sub 0b1 PR review 遗留（2026-05-11 review）

PR #28 的 review 提出的真实问题，**0b1 此 PR 不修**，按所属 sub / 触发条件归类。区分于第 4 节"条件触发式"—— 这些是已验证的具体 issue，挂着等。

### 7.1 由 Sub 0c 承接（pg-boss 异步 lane 落地后自然消亡）

| 工作 | From | 谁解决 |
|---|---|---|
| `app/api/ingestion/[id]/import/route.ts:336-391` 用 `void Promise.allSettled(...)` 跑 `runProposeAndWrite` / `runAttributionAndWrite` —— fire-and-forget，process 退出会丢任务 | review #28 issue #4 | Sub 0c：这两条全改 pg-boss enqueue，retry / SSE / cost 留痕全有 |
| `app/api/mistakes/route.ts:137-181` 用 `after()` 跑后台 task 但首次 `after()` 无 try-catch | review #28 issue #6 | Sub 0c：同上，搬 pg-boss 时这块 after 调用也撤掉 |

### 7.2 由 Sub 0z 解决（部署期 GC / 监控）

| 工作 | From | 谁解决 |
|---|---|---|
| `app/api/assets/route.ts` DB insert 失败时 R2 留 orphan object（虽然 content-addressed，长期攒）| review #28 issue #2 | Sub 0z：weekly cron 扫 R2 vs `source_asset` 表的 diff，删 orphan |
| `src/server/export/archive.ts:322-331` 单个 R2 上传失败不会中止整个导入，无 retry | review #28 issue #7 | Sub 0z 或独立小 PR：导入路径用 batched-retry helper |

### 7.3 触发条件式（流量 / 用户主诉时再处理）

| 工作 | From | 触发条件 |
|---|---|---|
| `app/api/ingestion/route.ts:38-52` N+1 query（循环里逐个 select） | review #28 issue #9 | 单用户低流量不修；用量上来或测试发现 timeout 时改 `inArray` 批量 |
| 同文件 `:172-193` 逐个 insert question_block | review #28 issue #10 | 同上，改批量 insert |
| `src/server/knowledge/tree.ts:33-38` 循环引用静默返回部分结果 | review #28 issue #11 | 用户报"知识树显示不完整"时再改为 throw |
| `app/api/review/submit/route.ts:85-117` 无法区分版本冲突 vs DB 错误 | review #28 issue #8 | Sub 1 review 系统调整时一并修 |
| `app/api/ai/[task]/route.ts:17` JSON parse 失败默认空对象 | review #28 issue #12 | Sub 0c 改 ai/[task] 路由形态时一并加 Zod 校验 |

### 7.4 测试债

| 工作 | From | 谁解决 |
|---|---|---|
| `app/api/health` 无测试 | review #28 测试评估 | 写一个 4 行测试即可；优先级低（4 行 handler 无逻辑） |
| AI 路由测试仅 3 个用例，需扩展到 15-20 | review #28 测试评估 | Sub 0c 改 `/api/ai/[task]` 路由形态时一并扩 |
| 15 个 skip 的测试 | review #28 测试评估 | 各 sub 收尾时检查是否其负责；Sub 0c 收尾时扫一遍批量 |
| 并发测试仅 1 个 | review #28 测试评估 | Sub 0c 接入 pg-boss 后天然多出并发场景，届时补 |

### 7.5 已在 0b1 修复

| 工作 | 状态 |
|---|---|
| `src/server/ai/runner.ts` 流式 callback 中 `writeToolCallLog` / `writeCostLedger` 失败吞错 | ✅ 已修（2026-05-11）：try-catch 包装，log 写失败降级为 console.error，不破坏流；同步 `runTask` 路径同样处理 |

---

## 8. 文档 / ADR 落盘清单（已完成）

供回看时定位：

- ✅ `docs/adr/0001-typescript-monolith-with-python-sidecar-escape-hatch.md`
- ✅ `docs/adr/0002-structured-extraction-vs-llm-analysis.md`（含 2026-05-11 修订段）
- ✅ `docs/adr/0003-defer-ai-provider-abstraction.md`
- ✅ `CONTEXT.md`（领域术语表）
- ✅ `docs/superpowers/specs/2026-05-11-sub0c-async-and-ocr-upgrade-design.md`（本文档主体设计）
- ✅ `docs/superpowers/specs/2026-05-11-sub0c-handoffs.md`（本文档）
- ✅ `tests/fixtures/tencent_question_split_sample.json`
- ✅ `tests/fixtures/tencent_question_split_nested_sample.json`
- ✅ `tests/fixtures/tencent_mark_agent_cloze_sample.json`

待跟进：
- ⏳ `docs/architecture.md` 加"异步任务层 (pg-boss)" + 更新"AI 任务层"（Sub 0c acceptance 列表内）
- ⏳ Sub 0c plan（步骤化 checkbox 的 `docs/superpowers/plans/2026-05-11-sub0c-async-and-ocr-upgrade.md`）—— 等审一晚 spec 后再拆
