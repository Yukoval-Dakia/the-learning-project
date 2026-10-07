# YUK1376 错题读取迁移

实现提交：`d231403441345b7a6936cec10157df741d69c955`，基于main `36f719675`。状态：PR1598于2026-10-07 19:02:53Z合入main `c7c2482ca`。独立初审P0/P1 NONE，准确head `291f1c5b3` 的CI Gate `37669157822`全部成功；合并tree `b55aff84e4212d3ee65161323551d4eca5c2edf9`与候选一致，17分钟等待窗已满足。未部署，未核销Start挂载或旧SPA退出。

## 行为与接口

`ingestion/public.ts` 导出 `readMistakes(db, input)`，共享现有GET与后续Start读取。input使用现有limit/since/question_id/subject/cursor查询契约，统一校验、默认值、科目派生和分页投影；Start须在鉴权后提供可信DB。`ingestion/ui-public.ts` 的 `listMistakes` 经generated API operation与响应schema读取，页面类型由契约派生。

修复了三项真实DB复现：冻结题面被当前编辑覆盖、已保存错答图片未返回、同题大量失败记录的深cursor页因读取窗口截断消失。有效快照包含冻结父题；无快照仅在时间戳及编辑事件可证明未变时读取现值；损坏或不支持快照保留记录与答题/归因证据，题面诚实缺失。补读仅针对当前页缺失attempt身份，保留纠错和过滤边界。

Native FailureAttempt上游尚不支持题面/答题图片快照适配，本提交没有完成该适配，不能据此核销完整native错题体验。YUK1243的旧attempt缺少learning_record回填是另一根因，本次分页修复不关闭该票。视觉和原交互保持；真实浏览器导航、lightbox、鉴权与Start挂载仍需验收，见1359退出矩阵。

## 验证

- 作者59 DB、16 scoped unit、typecheck/lint/build通过；Node24.19.0与既有安装，无依赖变更。Lint297条既有warnings，bundle大小提示保留。
- capability boundaries、partition、API contracts、API client usage audits通过；partition六条既有warnings不属于本lane。
- 父核验137项文件/日志/build hashes；manifest SHA256 `325729f513e12ee505b3dec5a9f8d7c26facccb47758aaab2e0d4aed3e4dfa88`。
- 父在固定d23140344上独立运行 `pnpm vitest run --config vitest.db.config.ts src/capabilities/ingestion/api/mistakes.db.test.ts`，59 passed，exit0。日志 `/tmp/yuk1376-parent-db.log`。框架隔离DB，无主运行库或provider调用。
- RED `/tmp/yuk1376-red-db.log` 与 `/tmp/yuk1376-red-cursor-db.log` 保留；完整作者记录 `/tmp/yuk1376-implementation-evidence.md`、hash清单 `/tmp/yuk1376-artifact-manifest.json`。
- 独立初审task `yuk1376-independent-review-20261008-v1`，codex/gpt-6.1-sol/xhigh，只读固定d23140344，P0/P1 NONE；后续仅文档。Codex额度耗尽、CodeRabbit跳过，无新增finding，不宣称它们完成了代码审查。

本线程拥有领域交付、PR和1359证据；主线57961995拥有Start组合根挂载及1352/55/56集成。无部署锁或runtime操作，无付费provider，无DLQ重放。三项修复已纳入1376；1243仍独立Backlog，native完整投影是尚未核销的迁移验收边界。


## Native读取接续

从已合入的 `c7c2482ca` 创建 `feat/yuk-1376-native-mistake-evidence`。只读调查已完成，父抽查实际schema和公开DTO，主线确认读取适配归本线程。拟修改 `src/server/records/mistakes.ts`、新增同目录 `native-mistake-evidence.ts` 及scoped DB测试、`src/capabilities/ingestion/api/mistakes.db.test.ts`。父随后直接读取78cabefd原线程position1586，确认其18:59:01Z已逐条声明四路径无WIP、无计划、可立即开工。已启动唯一writer `yuk1376-native-frozen-read-implementation-20261008-v1`，codex/gpt-6.1-sol/xhigh，父不并发代码或测试。

使用submission/revision/issuance冻结坐标，优先复用公开发题投影的绑定校验与私有材料过滤。按发出part、slot和group evidence目标读取原始作答，不复制整组证据到无关卡片；图像需匹配身份、digest和所属范围。参考答案必须遵守已有揭示策略，不能将scoring basis或私有rubric直接公开。缺席与损坏分别处理，不回退到mutable题面。多part、多submission、各响应类型、重判撤回和正常编辑后的历史稳定性均需真实scoped DB验证。不改kernel契约、评分写入、全局组合根或UI，不增加表或回填历史。

真实附件验收另需走鉴权content端点，核对原始字节、缺失附件及未授权请求；返回ID和SSR附件按钮不等于浏览器Lightbox已验收。冻结题面媒体完整呈现仍须单独核销，不能以本轮文字投影代替。


## Native实现交回与父验证

实现 `002712b79a9318dae35d8d7a320e5e5cec559432` 只改已约定四文件。唯一writer已completed/noPending、工作树clean。helper批量读取当前页submission及其原issuance/revision，复用公开发题投影，按part/slot投影文字与图片，不读取mutable question拼native历史。source_asset的digest、MIME、大小和上传时间须与冻结附件一致。

保留RED证明原GET题面、选择答案及图片为空。作者95DB、48unit、typecheck/lint/build及capability/API/schema audits通过；父核127项hash全部匹配，manifest SHA256 `71a2c1e51971d01b396db3e3edfbda3594803ec5bf84dcbf3c150bf62c90f135`，并在固定002712b79上独立复跑两份scoped DB文件，95 passed、exit0。父日志 `/tmp/yuk1376-native-parent-db.log`。作者完整证据 `/tmp/yuk1376-native-implementation-evidence.md`。

独立初审 `yuk1376-native-independent-review-20261008-v1` 已启动，codex/gpt-6.1-sol/xhigh，只读固定002712b79对3fef55277；结果待交回。准确head CI及真实HTTP/附件字节验收尚未完成，未部署。

native参考答案继续null：该读取路径没有持久化的可信reveal-policy输入，不临时发明全公开策略。严重损坏冻结坐标导致kernel无法确认effective failure时，原reader先过滤该行；直接helper损坏输入测试不能证明GET会展示这种unknown行。本次不改既有kernel过滤或伪造失败。figure仅有公开caption/alt摘要，完整图片与非图像媒体展示尚未完成。这些边界继续属于1376/1359核销范围，不能以本次95DB宣称整个迁移完成。


### PR1599初审与修复

初审固定002712b79，P0 NONE、两项P1。`anchorUnits`要求slot交集，遗漏合法仅依赖group evidence的unit；按单submission issued范围投影评分依据，又遗漏联合评估跨part unit及依赖完整范围的聚合器，导致本submission自己的合法图片消失。父已核scoring schema和assessment-verdict的冻结成员并集解析。唯一writer `yuk1376-native-p1-evidence-scope-repair-20261008-v1`在原四文件修复，先通过真实GET/DB复现。原95DB不能证明这两项通过，旧候选不进入runtime验收；修后只安排剩余一次验证审。

隔离预检仅确认当前Agent TEST主release仍5aa2/9b76、四服务健康及当时未见部署锁。已保存002的源码archive用于准备，尚未构建镜像或启动服务。实际服务验收前仍须重新核锁、原子获取并通知owner。


### P1修复及父复跑

修复提交 `f2013412370d7dc802dcf84dc70db6b96068a90e` 仅改四个授权文件。group-only unit保留整组证据关联；联合评分范围从已验证effective evaluation的冻结input_snapshot读取，回答与附件仍限本submission。两项均有正常发布、提交、评估激活和GET读取的有效RED；新增七项覆盖targeted/all_units、三种聚合器、跨成员隔离及未发unit排除。

作者102 DB、107 unit、typecheck/lint/build及四项audit通过。父独立检查262项hash全部匹配，并复跑两份scoped DB文件，102 passed、exit0，耗时11.52s。证据 `/tmp/yuk1376-native-p1-implementation-evidence.md`，父日志 `/tmp/yuk1376-native-p1-parent-db.log` 与 `-parent-hash-check.log`。DB由测试框架隔离，GET仍是进程内handler调用；未证明网络HTTP、真实图片字节或浏览器显示。

最后一轮独立验证审 `yuk1376-native-p1-verification-review-20261008-v1` 已启动，codex/gpt-6.1-sol/xhigh，只读固定f201对e4a。准确head CI及运行验收待完成。没有两项既有P1之外的新actionable follow-up；其余边界保留在1376/1359，不另建重复票。

验证审已completed/noPending，固定f20134123的P0/P1均NONE，两项原finding均resolved。审查追踪resolver成员与digest校验、不可变DB约束、分页范围、撤回过滤及私有内容隔离，核对四文件hash和RED/GREEN断言；未运行测试或操作runtime。初审加本次验证审预算已用完，不启动第三轮。后续提交仅更新交付文档。


## 隔离HTTP与原页面验收，2026-10-07 20:26Z

PR1599已合入7bc216509，tree与CI head6ab98ed8c一致；CI Gate37677610975成功、独立验证审P0/P1 NONE。隔离真实HTTP四行冻结错题、附件字节及负例通过；原页面刷新四行、语文筛选空列表、八张缩略图与Lightbox解码通过。20:26:50Z停止自有隔离容器并核owner释放锁，保留独立卷；主四服务healthy，release未变。整组图片真实模型评分、完整媒体/参考答案策略、Start挂载及旧入口退出仍未核销。

候选镜像 `sha256:8f60bc0c79f9231109dbbb897022e3fa7f94761f8b05b13a18699dff88e71ecc` 来自6ab98ed8c，合并tree为 `446b3e3787af39bfe6d1b540856fe9fb8966f2ba`。独立Compose `tlp-yuk1376-native-acceptance` 使用独立PG18995、S3 18994和app18996，无worker，无私人数据或provider配置。115迁移、epoch active及三条系统genesis均保留。

父实际执行fixture `aaeed06f832378d0670c796271c2561c60a8f29401e184a30ba5563ce5f4b5d3`，正常发布/发题/提交/确定性评估/激活/记录产生四行，覆盖partial、multipart及joint成员；修改working题面后仍返回冻结公开题面与本submission附件。实际网络HTTP校验图片原字节、SHA、MIME、ETag、304及401/404负例。另实际上传四个离线合成PNG，删除一个后读取404，非法上传400。未调用imagegen或产品模型。GET前后events/submissions/evaluations摘要不变，modelRuns为0。

证据根为 `/Volumes/YukovalSBak/yukoval-projects/tlp-local-prod-20260907.sjUaCU/yuk1376-preflight-6ab98ed8c/evidence`，主要文件为 `http-asset-receipts.json`、`fixture-seed.log`、`fixture-http.log`、`fixture-http-invariance.json`、`browser-acceptance.json` 和 `lock-release.json`。fixture及详细HTTP结果保留在 `/tmp/yuk1376-native-http-fixture`。

浏览器经真实token入口访问原SPA，刷新后四条冻结题面且无mutable/private标记；八个附件缩略图和Lightbox图片均实际解码。语文筛选显示零行。归因中状态对应隔离环境未启动worker，不能冒称归因执行完成。

本轮三图片在不同证据角色复用，不能代替完整独立图片角色矩阵；纯整组图片评分仍需合法模型准入与actual-output证据。确定性跨part fixture只证明投影范围，不证明图片理解。reference继续null、figure仅公开caption/alt，完整媒体呈现、Start迁移与旧入口删除未完成。保留在1376/1359，不另建重复follow-up。
