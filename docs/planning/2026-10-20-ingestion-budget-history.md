# 录入助手默认启动前置与历史还原 — YUK-1522

2026-10-20 owner 20:00/20:01选择拍整卷默认启动录入助手，20:04要求从历史完整还原录入页面。后端预算门完成前不默认开启。排期为1630收尾、1629、录入预算与历史，1634离线研究可并行，结论在本项之后。状态：草稿PR1891固定d4549704d初审5P1，父接受后已交原SWE-2 Max集中修；历史后续同writer串行，均未验收/部署。

## 已批准边界

协调选择LIGHT：录入助手独立的产品周额度，默认USD20，通过现有产品配置面可改。开发验收的`budget-week-*.md`保持原义，不纳入产品额度。仅管`POST /api/ingestion-sessions/{id}/operations`的`kind=agent`启动链，不给全产品后台加闸门。

最终LIGHT裁定：启动事务内复用产品本周已知/估价费用，按稳定身份与canonical attempt/ledger规则去重；另一个会话排队/运行/待结算，或unknown没有可靠上界时，明确503拒绝新的启动，绝不按0。达到配置额度返回429。原run与samekey返回原handle，continuation恢复同一持久身份。旧账/unknown不改。产品自然周一00:00至下周一半开区间，复用产品时区，无配置时Asia/Tokyo；不沿用开发账周六周期。跨周在途不因日历翻页放开另一新启动。

这只是启动许可，不保证单个已开始run不会超出当时余额，120轮/20分钟/最多8段保持原样，不新增单run美元上限或关OCR。下游准入另外记账，不能宣传整次录入全链路USD20封顶。严格逐调用预留/输出约束/8段与准入费用闭环另列YUK-1637（1559 C6，关联1558/1028），不作为本LIGHT前置。

前端已固定使用现有`{error,message,details?}`错误形状：

| 状态 | error | 学习者提示 |
| --- | --- | --- |
| 429 | ingestion_weekly_budget_exceeded | 这周录入助手的额度已用完，请下周再试。 |
| 503 | ingestion_weekly_budget_unavailable | 暂时无法确认录入助手的剩余额度，请稍后再试。 |

不自动重试、不静默降级。相同幂等键已在运行或已完成的操作继续返回原handle，不重复预留/启动。新请求、未派发的恢复请求与排队后实际启动必须遵守同一额度语义，不能只查HTTP首发漏掉恢复或跨会话并发。

## 已核源码与实施前缺口

只读固定main `4fd179818bd4a3ad8f16c07b2c9f38daa1adc259`：

- `ingestion/api/operations.ts`先重放同key，`reserveIngestionOperation`保留操作，按operation锁派发。它不提供跨session的周额度互斥。
- `ingestion/server/agent/run.ts`按segment运行`IngestionAgentTask`，最多8段；每段有sent标记、task_run_id与现有日志。必须核清工具调用是否有独立费用归属，不能只数主模型成本冒充整次录入成本。
- `cost_ledger`与provider attempt已有reported/estimated/unknown事实；同task_run_id不能重复求和。现有实际费用行不表示排队/运行中的预留。
- `system_config`有revision/journal与app-worker共享配置，复用现有注册/管理面；日费用告警不能当周额度硬门。

预算与历史分别收敛具体diff；不以未知金额或无效余额让功能永远不可启动，也不为本入口另建全局预算系统。数据库/迁移/产品写入前先完成真实状态与现有模块接口核查。

## 历史还原必需范围

UI依据`tlp-status/_work/ui-rebuild/pages/record.md` §4.2（核查main0f722b073）提供G1–G13。主线正在按新main复核，优先复用持久事实，扩现有读面：

- G1：会话列表纳入agent草稿的`draft:<actorRef>`绑定，返回agent/extract路径、状态、题数、开始/结束时间与可用标题来源。
- G2/G3/G4：每题页码、原图asset、题号/顺序、题干预览、已收好/先不出/失败/等回答，typed hold_reason、模型解释、question_id。准入状态要有明确revision来源。
- G5/G13：追问文字与类型、题归属、回答或超时跳过、提问/回答时间；超过7天未答明确未回答。
- G7：题目、问答与读页/找题/解题/核对最终进度长期保留，不依赖30天清理的job_events。不能用最新题库revision悄悄改写当时录入结果；当前准入状态须和冻结历史区分来源。
- G6：补agent operation运行与完成/失败终态，保留现有operation轮询契约。

G8区域框、G10多段打码回执、G11上传后用途变更、G12费用/分段展示留后续，本片不扩。

## 质量与证据

owner20:24要求：跨模块只经public/kernel；不新增capability→server或跨capability值依赖，确需同PR抵消并写baseline note。新文件不超1500行，已有超过1000行先考虑拆；不加纯透传包装或re-export凑边数。审查检查深模块：窄接口隐藏完整职责，调用方不需要知道内部顺序。

不编写测试或断言脚本（临时目录也算），除非另有owner批准。静态typecheck/lint/build与独立付费路径审查后，真实副本分别验证超额/未知拒绝、重复与并发启动、运行费用对账、重开历史与长期保留。运行窗口归迁移线；当前全部运行验收NOT_RUN，未默认开启、未部署。

查重后沿YUK-1522，预算/历史评论2415f0ad、298b5270；YUK1209是旧hot-budget扫描、1558是外圈防失控，不冒称本周额度已经实现。


## 2026-10-20 历史地图父核

Luna只读任务完成，父按main58289c补读operation-store、agent-progress、asks、run与session-detail：

- `operation-store.ts`的幂等接受和状态本身也投影自job_events；长期化必须覆盖同key身份，不仅页面字段。agent resume/continue payload不带operationId，不能只在首segment handler写终态，须从持久session-run绑定恢复操作身份。
- `server/events/agent-progress.ts`集中写session、ask与internal run三类stream，可以在这条既有写口同事务维护长期状态。调用既有Tx须保持同事务；传Db时由模块封装事务，不让调用方另行排序双写。
- asks的created/answer_claimed/resolved含幂等指纹与答案，保留运行读写语义；UI只公开问答/时间，不公开internal context_md或指纹。7天外未回答不虚构成timeout。
- `report_ingestion_progress`目前分开写UI item与internal linkage，并由模型报question_id；持久历史题目关联应核真实draft/submit身份，不能相信model声明admitted。发布入口返回的精确revision与来源需要保存。
- 准入会把输入revision的付费结果发布成新的resolved revision。因此历史关联必须能沿该次准入回执归到结果revision，不能简单要求current_revision永远等于初次submit revision，也不能拿任意后续人工修订覆盖原历史。当前可出态可经已有public/kernel读面单独投影，不新增ingestion→practice内部server边。
- 原素材/source package、learning_session可复用；源文件及策略仍按现役权限。新UI历史保存已有脱敏preview、问答与必要显示事实，不额外复制原始provider思考或私有评分材料。
- 旧会话只从仍存在的事件与不可变revision有界恢复；已无源的字段标缺失。没有执行任何回填或改prune政策，运营负责将来获批数据窗口。

G6选择补operation终态，不采用调查者“暂从session读”的替代建议。budget与history都可能触run/store/schema，实施由同一writer按切片顺序处理，避免并行写同一diff。Astra high只读设计已结束，父核agentic maxCost与GLM OCR无输出上界事实；协调明确选择启动门并将严格cap转1637。设计不是代码审查。

## 实施占用与核查

SWE2 Max独立任务`stage1-yuk1522-ingestion-light-start-budget-swe2-max-20261020`从最新main实施预算入口/持久身份/G6终态；不碰历史列表/逐题/asks读面或provider发送runtime。canonical cost读取如须迁kernel，架构线已确认其无writer，旧consumer真实迁入、不留纯兼容shim；不据此替其他线释放。后续产品scope以此固定brief与Linear788145b6为准。


## 旧 alias 清理的文件协同（2026-10-20）

架构线按协调批准清单 37ee3655… 撤 POST `/api/ingestion/[id]/extract`、`/import` 及孤立 `api/extract.ts`、`api/import.ts`，canonical operations 保留。父已核本线在途树 `t3-c186b58d`（当时 HEAD46663192d）：两个 alias 文件无本线 diff；`ingestion/manifest.ts` 仅 operations responseSchemas 新增503的4行，和旧 alias 注册不在同一段。架构线独占两旧注册删除，本线保留 operations/503；后合按 main 正常合并，不整文件覆盖。已同时通知架构线和当前预算 writer；此确认只覆盖本线所有权，不替其他线释放，消费者复核仍由清理线执行。未新增 writer、未操作 runtime。


## 草稿 PR1891 初审与父核

作者树 `t3-c186b58d`，base46663192de354dfe09aa8a474b5030b2726116eb → d4549704ddc387db25ea4c564db4eb8823480b12，18文件；新增 learning_session.agent_budget 与0128、费用读引擎下沉kernel、现役operations/agent/G6接线。实际沿既有 learner-day 时区 Asia/Shanghai 自然周，不沿开发周账。

Codex gpt-6.1-sol xhigh 独立R1为 CHANGES_REQUESTED（5P1/0P0）。父核相关源码后接受：0128 journal时间倒退会跳过现有安装升级；费用CTE identity UNION text/uuid冲突；OCR原始anchor已散列UUID而prefix过滤漏计；crash执行终态释放grant但费用未结会放行；job_events TTL和16条裁剪使同key到原handle的权威绑定丢失。报告 `tlp-status/review/stage1-ingestion-budget-history-20261020/pr1891-r1-d4549704d.md`。

父实际 typecheck0、build0；完整 pnpm lint exit1，postman/api-endpoints.json格式错误及180warnings，不是作者摘要的“仅6warnings”。日志 `/private/tmp/yuk1522-pr1891-parent-d4549704d/`。修复已交原writer，任务 `stage1-pr1891-swe2-max-r1-five-p1-repair-d454-20261020`；新head后仅一次R2，无第三审。允许实际OCR边界的必要持久关联，仍不扩成整链严格金额上限；unknown无证不释放，同key权威不随TTL/数量裁剪删除。回滚不删除已有授权/费用历史。无新增测试/断言脚本，真实并发、升级、恢复、DB/provider/部署均NOT_RUN。

作者新建YUK1638是queued job丢失后session恢复跟进，已与643旧operation资源票等查重；它不豁免本PR未知费用占位缺陷，也不授权因时间或job消失就重发。跨线alias注册删除仍由架构线负责，本片只保留canonical operations响应503改动。

所有后续brief加入协调新规则：禁止停止OrbStack或Docker daemon；本片实施与审查没有服务控制权限。

## R1修复交付与唯一验证审

原修复回合连接失败，task_status确认无pending子回合；父保留6个未提交文件后在同SWE2 Max树续跑，未reset/新开作者。当前固定head `6eea1b3250b6e2f814f886f790327640b5b97463`，工作树clean。修复涉及0128时间、费用UNION类型、OCR真实operation持久归属、awaiting_cost占位、持久key/input/original handle及POST/GET恢复；budget.ts实际967行，未增测试。作者“五项闭环”尚待父与独立验证，不当作接受结论。

唯一Codex gpt-6.1-sol xhigh R2任务 `stage1-pr1891-codex-verification-r2-6eea1b325-20261020` 已启动，只读固定diff，报告预定 `tlp-status/review/stage1-ingestion-budget-history-20261020/pr1891-r2-6eea1b325.md`；无第三审。将历史无归属OCR不计入的边界、PR“drop列但保留历史”矛盾一起交核，未同意放宽unknown或删授权。

OOM协调新规已给作者及R2：本机重命令全经 `/Volumes/YukovalSBak/yukoval-projects/tlp-status/_work/heavy/heavy.sh`，全机/本线最多2个；父明确Node堆3072MiB并串行typecheck/lint/build。13:31:48→13:32:14Z三项均exit0，日志 `/private/tmp/yuk1522-pr1891-parent-6eea1b325/`。未install/测试/DB/provider；作者回报原检查已在新规前退出。本head GitHub audits(contracts)红，父取原日志归因中，不默认flaky、不重跑；其他CI尚未收齐，未ready/merge/部署，默认启动不开放。


父随后核GitHub job118654475888原日志：contracts红仅 `gen:api-client` 后503响应14行未提交；完整原始/去ANSI日志及SHA已封 `pr1891-6ee-ci-contracts/`，未重跑。作者已退出后父作为唯一代码写者运行现有生成器，diff仅 `src/ui/lib/api-schema.generated.ts` +14，提交 `6c82d2f425a9c85adca8aade534ce6f8c7bd6571`。唯一R2仍审固定6ee付费逻辑，已告生成delta；父在6c82经heavy.sh/3072MiB串行typecheck/lint/build全0（13:36:11–13:36:48Z，180warnings），日志 `/private/tmp/yuk1522-pr1891-parent-6c82d2f42/`。新head待exactCI。PR回滚说明已改为保留列及授权/费用/幂等历史，回退代码前关闭默认自动启动，禁止drop列丢记录。Linear父补证bd6123c9。

## Codex 接手实施：永久 operation 身份与未结费用（2026-10-20）

从 clean `6c82d2f425a9c85adca8aade534ce6f8c7bd6571` 继续原树/原分支/草稿 PR1891。已逐字读完整 R2，接受五项 P1；journal 时间顺序与 UNION text 类型已关闭，保持不动。R1/R2 预算已用完，本轮是唯一作者修复，禁止再委派/第三审。父生成的503响应14行保留。此节取代上文“作者五项闭环”及历史无归属可排除的旧陈述。

实施前确定的修法：

1. **历史 OCR 归属与费用**：只用 `tool_call_log.output_json.run_ref = provider_attempt.attempt_id` 的精确身份作可证映射，保留来源 log ID；agent task-kind 证明属于 agent，其它明确 task-kind 证明独立调用，冲突或缺证保持归属未证。不猜 UUID 前缀，不把全体 OCR 加入 agent 金额。未绑定的 GLM `ocr_page_fetch` 及已观察后源证据缺失的负债保存在现有 `agent_budget` 内，未证不因周翻页或事件 TTL 消失。没有充分证据排除属于 agent 的历史记录，启动返回503。无 DB 权限窗口，本轮不能声称历史实际为空或运营已核销。
2. **新 OCR wire 缺口**：agent 自身先提交 pending liability，再进入原 GLM 调用；在实际 request callback 的 wire 前持久绑定精确 attempt ID。acquire 在 off/observe 下 fail-open 时仍有 pending，缺 row/普通 catch/零 usage 均不释放。只有 canonical 已结 USD 费用或明确未发送证据才可结束负债；不改变全局 provider/admission 模式、不关闭 OCR、不改变非 agent 调用。主模型同样持久保留确定性 task 身份，避免源日志清理使负债消失。
3. **跨周未结费用**：全历史 canonical 归属记录的 unknown、缺金额、无可信 USD 折算，以及 pending 身份找不到可信结算，都持续阻新启动。operation 可以 completed/failed，同时 grant 为 awaiting_cost。周窗口只用于已确定 USD 的本周 used 累计，旧周已知费用不会重复计入新周。
4. **拒绝也有永久身份**：`agent_budget.operations` 独立于 grants 保存 accepted reservation 的 key/input/handle/created/真实状态；与 accepted 事件同事务，先于额度检查。429/503 保存原失败状态而不造 grant；POST/GET 在 TTL 后优先读 durable 身份，同 key 不得重变付费。旧 grant/归属/费用全部保留、增量兼容，不裁剪。
5. **跨 kind 同 key**：所有带 key 的 collection 请求都在真实 key advisory lock 内先查 durable agent reservation/旧 binding，再查事件、校验 session、建立新 reservation；不同摘要409，相同摘要返回原 handle，不让后来的 extract 事件遮住。其它 kind 不建立新的永久历史系统、不改预算策略。

职责拆分：`operation-identity.ts` 拥有 reservation、旧 binding 兼容、终态/readback；`agent/spend.ts` 拥有 pending liability、历史证据归属与全历史/本周 canonical 成本；`agent/budget.ts` 保留 grant 授权/在途/配置/结算。内部共享信封只负责路径级写入与解析，不用重导出/透传凑模块。所有新模块同 PR 接真实消费者，无新跨 capability/server 值依赖。

锁与崩溃约定：reservation 的 key 锁 → 本 session 行，事务结束后才进入 per-operation dispatch 锁；dispatch 的预算锁 → session 行，worker 只取本 session 行，不反向申请预算/key 锁。预期预算拒绝必须提交历史未证标记和失败身份，所以 `enqueueAgentRun` 的现有 beforeTransition hook 须允许返回拒绝结果、在事务外再转 HTTP error；不靠抛错回滚掉财务证据。grant 仍与 session queued 事务绑定。pg-boss 既有独立连接的 send/commit 缝隙不伪称消失，恢复凭原身份和真实 session/任务证据，不再授权；send 结果不明保守保留。

历史保守边界：没有新的可信汇率/金额上界；CNY 有真实估价也不能伪装 USD。相关旧 OCR 若缺精确归属证据，产品可能无法默认启动，需运营按原 attempt/log/来源核对，不能发行说明豁免。零条源结果不能擦除已经持久观察到的未证状态。运营修复不在本轮执行；不删列/原历史，不重放 unknown。

验证仅 heavy.sh 串行 typecheck/lint/build、受影响既有 audit 与必要生成，Node 堆≤3072MiB、全机槽≤2，无 install 需要不安装。所有测试/断言脚本（含临时目录）、DB/迁移/TEST/Docker/provider/paid/daemon 控制、merge/watch/部署均 NOT_RUN。静态控制流核对不冒称并发、TTL、跨周或费用实跑验收；完成后由父定向验证。

实施补充：实际 worker 终态才可写 `execution_closed_at`；queue-vanished 或 HTTP 恢复不能证明已 claim 的执行者不会继续，原 handle 如实失败、grant 保持 awaiting_cost，不凭无 job/无 task 解锁。已有 grant/job 的同 handle 不再重新 enqueue。失败写入留在 per-operation dispatch 锁内，避免旧请求的迟到 catch 把另一个重放已成功派发的 handle 改成 failed。旧 grant 的 key 及原 handle 兼容读取，事件仍在时将其 reservation增量持久化，不删原字段。

本轮 typecheck-01 exit1（error 对象的 index signature 类型）已修；typecheck-02 exit0。日志均保留，未把失败覆盖成成功。协调最新每线重活最多1个，全机2槽；当前作者树尚无main内置限流，检查继续外部heavy.sh。五项源码接线完成后先普通commit，再正常整合main，保留main架构下降历史/限流脚本，核package真实命令后进行最终串行检查。此整合授权不开放测试、DB、provider或部署。


## R2裁决与重新分派（不再开审查轮次）

唯一R2报告 `pr1891-r2-6eea1b325.md` 为CHANGES_REQUESTED/0P0/5P1。父核真实费用SQL、finalizeGrant、operations查key/reserve顺序以及provider生命周期off/observe的untracked fail-open，接受五条：历史无绑定OCR漏账；新OCR绑定后无attempt仍可能已发送；finished unknown经reconcile/跨周释放；预算拒绝无grant的handle受事件TTL清理；不同kind绕过并遮盖已有agent key。0128时间与UNION类型两项源码关闭，不能据此认为全门可用。生成6c82不改变这些产品路径。

原SWE两次交付未闭合关键边界，父收敛为持久operation reservation与未结费用生命周期两个完整职责，在同一个已释放作者树改由Codex gpt-6.1-sol xhigh/default执行；已用T3 configure并读回确认，不修改权限、不新增工作树或install。新任务 `stage1-pr1891-sol-xhigh-r2-five-p1-repair-6c82-20261020`。原review完成，禁止第三审；完成后父定向验证五P1。范围限ingestion内部真实消费者/现有持久列，避免global provider模式改变/全产品预算；如需共享provider writer先列具体不可避免范围。

历史相关费用证据不足继续503，不默许旧OCR排除/无row当未发/周切换清负债。预算拒绝需持久请求身份而不是赠grant，带key的所有collection请求都守已有agent绑定；其它kind的预算范围不扩大。原错误路径和运行NOT_RUN保留。Linear裁决20fe2f77，协调已告仍不开默认助手。
