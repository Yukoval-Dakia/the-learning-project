# YUK-1341 产品 AI 路由迁移

Owner 最新纠正：“我指的就是产品内的ai工作，不是开发工作。”目标是 Loom 的判题/评分、辅导/Copilot、记忆整理/压缩、规划和其他生成式多模态调用统一 `opencode-go / mimo-v2.6-pro`。开发代理继续按 AGENTS 使用 Sol6.1 high。T3 `providerInstanceId=opencode` 不能当成产品 provider id。

本 writer 在 `tlp-yuk-1341-mimo-go` / `fix/yuk-1341-product-mimo-routes`，base `8a53792855580fc1eec2c344b70f4122e5310bb7` 实施。父线程负责 review、PR、CI、集成和生产发布。本说明是源码接线与隔离验证交接，未声明生产已切换。

## 消费者与选择顺序

[完整源码盘点](evidence/2026-10-07-yuk1341-product-consumer-inventory.json) 来自现有 task census 的 AST 扫描：55 个 task，54 个聊天 task、1 个 typed task；每个 task 列出原默认 provider/model 和实际调用文件/行号。兼容 `AttributionTask` 暂无 live caller；Jev 的动态 typed dispatch 单列。任务审计的 70 个静态调用点与 43 个 manifest/job 可达链不等于 70 个不同产品功能。

| 类别 | 真实消费者 | 旧选模 | 目标接线 |
| --- | --- | --- | --- |
| 通用聊天任务和流 | `src/server/ai/runner.ts` 的 runTask/runAgentTask/streamTask/collectStreamTask → `run-lifecycle.ts` | explicit override/modelBinding > global > DB task > registry；registry 为 Xiaomi MiMo2.5 | `providers.ts` 中聊天 **env pin > explicit > DB global > DB task > registry**；遍历全部54个聊天 task 的测试覆盖旧 override、persisted binding、tool/vision 能力 |
| 原生评分 | `src/server/assessment/pi-model-executor.ts`；Practice `judge/evaluate-submission.ts`、formal paper/placement/practice entries | AssessmentRuleJudgeTask，Xiaomi/mimo-v2.5 | 同一 runner + pin；保留 frozen unit、资产 digest、admitted slice、withheld、cost reservation、pending、exact citation 校验 |
| 旧判题、申诉、教学检查 | Practice `judge/invoker.ts`、`question-contract.ts`、`source-grounding-verify.ts`、`provider-lane-fallback.ts` | SemanticJudge/Steps/MultimodalDirect/UnitDimension，含局部 vision 和 durable provider override | pin 压过局部模型；pin 下不做 registry cross-lane fallback，避免重复烧同一模型；402仍为失败 |
| 校准抽样 | `practice/jobs/judge_calibration_sample.ts` → `judge-calibration-sample-core.ts` | 显式 anthropic-sub/Opus，可由配置指定 | 配置 reader 把 env pair 投影到 rejudge provider/model，实际调用仍由 resolver 校验；不虚称异源，既有 sameLaneSuspected 标记保留 |
| Copilot / 辅导 | `copilot/jobs/copilot_run.ts` → `server/copilot-execution.ts`、`tasks/agent.ts`、`teaching-turn.ts` | Xiaomi，可带 durable modelBinding | 全局 pin；子 agent `server/subagents.ts` 未指定模型，`PiAgentAdapter.childModelFor` 继承父模型；durable FIFO、取消、tool logs、回放不改 |
| 会话压缩 | `pi-agent-adapter.ts:buildTransformContext`，Copilot nativeCompaction | 确定性 prune、replay、bounded context reinjection | 无额外 LLM 调用；父 loop 后续仍为 MiMo。不是另一个需要改模型的摘要服务 |
| Mem0 抽取 / 整理 | `src/server/memory/client.ts:createMemoryClient`，`triggers.ts`、`read.ts` | Mem0 OSS OpenAI adapter，直接 GLM5.2/ZHIPU key；原全局开关不覆盖 | `memory/llm-config.ts` 复用全局 pair，native catalog baseURL，OPENCODE key；旧 MEM0_LLM_* 在 pin 下不生效；真实 SDK 配置保留请求头、timeout、maxRetries=0 |
| 直接记忆调和 | `memory/reconcile-llm.ts:judgeReconciliation` → `triggers.ts` | GLM chat HTTP + GLM CNY估价 | 同一 memory LLM config，Go header=provider_attempt.attemptId；provider/model真实，usage按响应，Go cost保留unknown，不套GLM价目 |
| 直接知识边调和 | `knowledge/server/edge-reconcile.ts:judgeEdgeReconcile` → `propose_edge.ts` / nightly | 同上 | 同一配置/header/错误分类；无邻边继续确定性 KEEP_BOTH；保留 proposal owner、WAL、soft-delete gates |
| 规划 / 夜链 / 记忆 brief | agency 的 Coach/Dreaming/GoalScope/LearningIntent/Conjecture/ResearchMeeting/MemoryBrief tasks；Practice supply/selection/quiz planners | registry Xiaomi；`meeting/director.ts` 和 `conjecture/induce.ts` 显式订阅 override；solve_check 有 VERIFY_SOLVE pair | pin 覆盖显式路由和 scoped solve override。独立 prompt 仍独立任务，统一模型后不声称异源验证 |
| 生成、视觉、录入 | Practice QuestionAuthor/QuizGen/Sourcing/Variant/Solution/SourceGrounding tasks；Ingestion Vision/Structure/Tagging/BlockAssembly/ColdStart tasks；Notes/Knowledge tasks | Xiaomi text/vision defaults | 同一54-task runner覆盖；MiMo2.6Pro native catalog text+image；tool binding沿用PR1582，不更改生产工具权限 |

env pin 的优先级改变是本任务的产品策略。显式测试或操作工具若要验证其他聊天模型，须在其隔离进程取消 env pin；不能以 per-call override 绕过生产 pin。DB global 的既有 explicit 优先级不变；生产使用完整 env pair，避免热刷新时各进程的 DB 快照不同。Mem0 client 缓存实例，变更后必须重启 app 和 worker。

## 协议与数据边界

- Embedding 保留 `src/server/ai/embed.ts` 与 Mem0 embedder 的 DashScope `text-embedding-v4`。保留既有 MEM0_EMBEDDING_MODEL/BASE_URL/DIMS、pgvector collection及列维度。MiMo聊天没有已接线的 embedding API，不把文本当向量，不重嵌入历史库。
- `JevScoringDecisionTask` 是 OpenRouter `/systemone` 的 typed primitive，显式模型 pin 保留。它不是可替换聊天 JSON 的接口，仍受 frozen slice admission控制。高级生成式执行器为原生pi，走目标pair；不以本次小样本给所有评分slice准入，不退回Jev制造native成功。
- GLM `layout_parsing` OCR、Tencent OCR/QuestionMark 是专用识别协议，保留适配器与现有确定性识别/回退；其后的通用VLM、结构化生成/判题走MiMo。不是留旧Xiaomi生成式线路。
- Mem0 不接收图片，SDK 的未使用 get_image_description helper 不属于现有 live consumer。真实调用是字符串事件 + infer:true；SDK session UUID不冒作ai_task_run id。opaque provider_attempt仍记provider=mem0/model=null和未知SDK用量/费用；直接调和是单次Go请求，模型字段真实。
- 没有schema迁移、队列清理、DLQ盲重放、用户数据改写。旧402失败与历史成本保留。新聊天任务日志/cost为actual provider/model；Pi catalog价格只能记estimated。

## 证据、费用与门禁

PR1582 已合并，tool binding、公开 Sourcing tool_call_log、Copilot两轮、合成tool/vision证据沿用。原文件不修改、不覆盖；pre-binding标签纠正和约$0.034历史估值的局限仍以[原证据说明](evidence/2026-10-07-yuk1341-mimo-v2.6-pro-evidence-note.md)为准。该说明旧“产品路由deferred”是当时范围，已被owner最新纠正和本说明取代，不倒改历史事实。sharp0.35.5/MCP1.32.1不再升级。

新增 actual-output 文件使用唯一 capture id、exclusive create，测试仅 `YUK1341_PRODUCT_ACTUAL=1` 显式启用。四个场景各预留$0.75，总预留$3；每个场景单次，无失败自动重跑：frozen结构化数学评分、合成三角形图判读、真实Mem0 SDK抽取、真实记忆调和。Mem0抽取使用本地合成4维向量/内存store，仅LLM到真实Go；不把它当DashScope/生产pgvector验收。每份产物记录exact source revision、输入输出digest、task_run或opaque/direct attempt身份、tokens/cost真相。完整评分质量准入、真实生产浏览器和部署验收由父线程另行完成。

本地 unit/DB/static/audit/build 和 actual-output 结果见下文最终证据小节。完整 `pnpm test` 未运行。独立review、exact-head CI Gate、merge等待窗尚归父线程。

## 私有运行配置迁移与回退

目标目录 `/Volumes/YukovalSBak/yukoval-projects/tlp-local-prod-20260907.sjUaCU/deployment-20261007`。本writer未修改它。父线程报告app/worker仍是旧5d738dbc0 healthy、pair未设置、OPENCODE key存在；这不代表新路由已部署。

1. 父线程完成review/CI/集成，按现有发布要求锁定镜像revision，重新取得新鲜备份并做restore验证。旧备份有restore证据仍不能替代下一次fresh backup。
2. 私有app和worker共同设置 `AI_PROVIDER_OVERRIDE=opencode-go`、`AI_PROVIDER_MODEL=mimo-v2.6-pro`；继续使用已有 `OPENCODE_API_KEY`，不打印值。两进程可选的session admission策略要覆盖 `opencode-go`；不复制Xiaomi容量猜作新provider限制。保留各既有admission模式和recovery开关，必要策略由父线程核对。
3. `MEM0_LLM_MODEL`、`MEM0_LLM_BASE_URL` 无需添加，target pair优先。`DASHSCOPE_API_KEY`和所有embedding/collection/dimension/history配置保留。GLM专用OCR若启用仍需原识别服务认证；它不再为本轮记忆生成式调用选模。
4. app(read)/worker(write)同时更新新镜像和同一pair后重建/启动；migrate没有模型请求但仍沿正常发布流程运行。没有独立Mem0容器；mem0volume不迁移、不删除，app/worker各自history路径保留。私有Compose仅app/worker/migrate，禁止down/remove-orphans/down-v。
5. 启动后检查两进程的变量名/非秘密provider/model值与key存在布尔，再查看新的ai_task_runs、provider_attempt、tool_call_log、cost truth，做有界合成产品场景验收。不要盲重放旧402/DLQ请求。

配置回退：停止新AI接纳并按既有恢复纪律停/等writer，恢复切换前的两项pair状态及既有MEM0_LLM_*，同时重启app/worker以清除缓存client。该回退回到旧registry Xiaomi和GLM；Xiaomi402已知仍会失败，不能声称恢复日用。需要保留可用的上一版Go配置/镜像时，以父线程已验证的版本为准。无schema改变不免除发布时的恢复/旧镜像兼容检查；不得自动覆盖生产DB或删卷。

Linear capture与PR操作按任务约束留父线程。当前新增可行动事项只有本任务内修正，未对外建票；YUK-1342探针封存跟进继续存在，本轮harness只做任务专用安全开关，不扩张通用系统。


## 最终本机证据与父线程交接

付费执行源码精确revision：`14cb6b3263b6d78a4b3e142575f67e3f9727a88d`。首次捕获前工作树干净。四例在一个隔离testcontainer运行，4/4通过，27.52秒模型测试耗时；没有付费重试、生产DB调用或队列重放。后续改动只涉及probe证据过滤、其unit测试、文档和产物，产品运行代码未改变。最终HEAD本身没有重新付费调用，不把原revision的实证冒作新HEAD实跑。

| 场景 / 净化封存文件 | task_run / provider_attempt身份 | tokens in/out | 结果 / 费用USD |
| --- | --- | --- | --- |
| [native-math](evidence/2026-10-07-yuk1341-product-1ff4a95b-c9e6-42c1-870a-a17e261d049f-native-math.json) | `f4d82fc0-9dd0-470c-a6a5-baa018623cb0` | 953 / 226 | 静水速度15 km/h，5分，exact quote；estimated 0.000611175 |
| [native-vision](evidence/2026-10-07-yuk1341-product-1ff4a95b-c9e6-42c1-870a-a17e261d049f-native-vision.json) | `6a50bdf6-b1ff-4797-972e-c609280fe2cd` | 1016 / 343 | 读出直角边3/4，斜边5、面积6，5分；estimated 0.000519506 |
| [mem0-extraction-redacted](evidence/2026-10-07-yuk1341-product-1ff4a95b-c9e6-42c1-870a-a17e261d049f-mem0-extraction-redacted.json) | `0bc221fe-0e90-456d-ad37-301fbe4dd4b0` | wire 8116 / 142；SDK ledger unknown | 真实SDK抽取椭圆画图/反例偏好；cost unknown |
| [memory-reconcile-redacted](evidence/2026-10-07-yuk1341-product-1ff4a95b-c9e6-42c1-870a-a17e261d049f-memory-reconcile-redacted.json) | `1c24583b-13bd-4b1c-9311-42953e0e9e4d` | 529 / 131 reported | SUPERSEDE旧“不画图”偏好，confidence0.88；cost unknown |

四份均保存输入/业务输出SHA256；图像另有字节digest；native保留完整ai_task_runs/cost_ledger，Mem0/direct保留provider_attempt。mem0不伪造task_run_id：opaque记录仍为mem0/model=null；代理捕获的真实响应明确model=mimo-v2.6-pro。直接调和记录为opencode-go/mimo-v2.6-pro。native两次Pi catalog estimated合计$0.001130681，不能冒作invoice。两次记忆成本unknown，各保守占用$0.75，合计保守占用$1.501130681≤$3；开跑时四例总预留$3。raw tokens只作探针观测，没有把未知SDK费用回写为已知或零。

捕获后的隐私校验发现两份task-owned、未提交的provider JSON含reasoning_content。已移除该原始推理正文，另存`-redacted`唯一文件并移除未提交原稿；保留原稿SHA256、业务结果/请求digest、exact调用revision和更正原因。没有覆盖PR1582证据，也没有为此重发请求。`productWireEvidence`在每层用allowlist schema仅保留最终content、response id/model、finish reason、tokens及cached/reasoning token计数；unit验证原始thinking、headers、credentials/debug扩展均剔除。provider整包digest是完整性摘要，不是可恢复raw JSON的快照。

验证结果：

- 最终集中scoped unit：18 files / 388 passed，涵盖provider、全部54聊天task覆盖、real SDK ESM/CJS、direct调和、loader双进程、adapter/stream/tool/compaction/错误/重试、worker boot和两类audit；另新增隐私allowlist unit 1 passed。此前重复的unit组不累计。
- scoped DB：3 files / 17 passed（native runner/成本、产品pin失败不重复回退、Mem0失败/原子性）；另2 files / 14 passed（recorded executor及native calibration入口，含admission/withheld边界）。共31项不同scoped DB，actual-output另列4项。
- `pnpm typecheck` PASS；最终local `pnpm lint` 0 errors / 297基线warnings；`pnpm build` PASS，web/server/worker/migrate。补probe过滤后执行scoped Biome/typecheck，不再重烧模型。
- provider-lanes、provider-attempt-truth、partition、capability-boundaries、architecture-deepening、schema、profile、task-census、draft-status、draft-status-reads、api-client、api-client-usage均PASS；capability→server/server→capability/cross-capability ratchets仍437/0/48，没有放宽。
- `pnpm audit --prod --audit-level=high` 无high/critical，3 low/15 moderate沿基线；sharp0.35.5与MCP1.32.1保留。
- 未运行完整本地`pnpm test`。没有push/PR/merge/GitHub评论/Linear/部署/用户级配置。独立review、exact-head CI、最终镜像和生产浏览器/API/DB验收尚归父线程。

此次没有未解决的聊天consumer绕过点。尚未实跑全部54任务/全部选用job、生产Copilot session入口或完整评分质量集；source/scoped证据不能替代它们。专用Jev typed、OCR、embedding边界见上文，不隐瞒这些实际服务仍在。YUK-1340 UI工作树和CopilotDock/UItests未触及。

## 提交文件清单

第一源码commit覆盖以下30个task-owned文件：

- `.env.example`
- `PLAN.md`
- `README.md`
- `docs/planning/2026-10-07-autonomous-delivery-charter.md`
- `docs/planning/2026-10-07-local-release-result.md`
- `docs/planning/2026-10-07-yuk1341-product-mimo-routing.md`
- `docs/planning/evidence/2026-10-07-yuk1341-product-consumer-inventory.json`
- `patches/README.md`
- `patches/mem0ai@3.0.13.patch`
- `pnpm-lock.yaml`
- `scripts/provider-lane-inventory.ts`
- `server/env.unit.test.ts`
- `src/capabilities/knowledge/server/edge-reconcile.ts`
- `src/capabilities/practice/jobs/judge-calibration-config.ts`
- `src/capabilities/practice/server/judge/provider-lane-fallback.ts`
- `src/capabilities/practice/server/pi-model-executor.db.test.ts`
- `src/capabilities/practice/server/product-provider-pin.db.test.ts`
- `src/server/ai/AGENTS.md`
- `src/server/ai/execution-adapter.ts`
- `src/server/ai/providers.test.ts`
- `src/server/ai/providers.ts`
- `src/server/ai/run-lifecycle.ts`
- `src/server/ai/yuk1341-product-routing-actual.db.test.ts`
- `src/server/boss/start-worker.ts`
- `src/server/memory/client.ts`
- `src/server/memory/llm-config.ts`
- `src/server/memory/mem0-sdk-failure.unit.test.ts`
- `src/server/memory/product-routing.unit.test.ts`
- `src/server/memory/reconcile-llm.ts`
- `vitest.shared.ts`

后续封存commit另含四份上述actual-output净化证据、`tests/helpers/yuk1341-product-evidence.ts`及其unit测试，并更新本说明/PLAN/probe import/vitest分区。父线程可按两commit顺序集成；运行配置不在git变更内。
