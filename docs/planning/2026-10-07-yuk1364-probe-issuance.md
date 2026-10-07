# YUK-1364 — TeachingBrief 正式发题与结果契约

## 缺陷和行为

旧 TeachingBrief 直接选择 legacy question，可能显示未正式发题的 probe；同一题提交会返回 `409 probe_not_issued`。测试中已用真实 route 和隔离 PostgreSQL 重现，不依赖已清空的私人旧数据。

选题现在要求存在正式 issuance、属于同一题组的 revision、admitted 且未 suspended/withdrawn 的生命周期，以及可投影的单一 open-response 契约。廉价资格过滤在候选窗口前执行，超过 50 条较新的未发题记录不会挤掉较旧合法题。题面来自冻结 issuance，保留提交端的 authored-snapshot 校验；GET 不补写、发布或修复旧题。

## 独立初审后的修复

初审发现 P1：active brief 使用冻结题面，而 completed outcome 校验仍读取可变 question。两条真实作答 route 回归重现：作答 200，随后 brief 为 null、ack 409、report 把合法结果计为 corrupt。

active 与 completed consumer 现在共享冻结题面投影。完成后的结果不重新要求当前生命周期仍可发题，合法 pre-issuance 历史结果保留原有语义；结果有效期和报告的历史窗口语义保持。正确/错误答案均覆盖作答、结果展示、确认和报告计数；后续停用、撤回、缺生命周期、题面编辑也有隔离回归。

## 验证证据

2026-10-07 首次 P1 修复后的记录（未覆盖下述连续复验缺口）：

- 7 个 scoped DB 文件、124 项测试通过，包含正式发题资格、完整结果链路及 probe-answer 消费者。
- 3 个 scoped unit 文件、52 项测试通过。
- typecheck、lint、build 日志完成；lint 为既有 297 warnings，无新增错误。
- 测试使用独立 Testcontainers PostgreSQL 和离线模型执行端，未操作 live loom、未调用付费 provider。
- 独立初审 P1 的红绿记录：`/tmp/yuk1364-p1-red.log`、`/tmp/yuk1364-p1-green.log`。最终回归：`/tmp/yuk1364-p1-db-final.log`、`/tmp/yuk1364-p1-unit.log`；其他门禁为相同前缀的 typecheck/lint/build 日志。

唯一验证审已完成，仍有一项 P1：带 follow-up 的连续复验通过 `probe-evidence.ts` 校验支持链，`supportingQuestionSequence` 仍读取可变题面、参考答案和版本。已正式发题的 legacy follow-up 编辑后，可能作答成功却使 confirmed 结果不可见、ack 409、报告误判 corrupt。该发现来自源码追踪；上述单次 probe 回归不能证明连续复验通过。

该 P1 已用两条完整连续复验链路 RED→GREEN 复现并修复。共享 evidence fold 对已发题结果读取冻结 issuance/revision，历史未发题结果保留旧校验；当时仍以可变 KC 作为来源校验；该限制由下述 GitHub P1 修复纠正。来源身份损坏和依赖撤销仍使结果失效。生产 guard、schema 和合法 fallback 选择规则未改。

最终 12 文件 248 DB、5 文件 72 unit、typecheck/lint/build 与 diff check 通过；父线程核对实际 diff、文件哈希后，独立复跑 issuance、Scout、accountability 三文件 85 DB 全通过。准确命令与哈希见 `/tmp/yuk1364-recurrence-commands.log`，父日志 `/tmp/yuk1364-parent-recurrence-db.log`。

负向 fixture 曾因冻结 guard、外键及合法初次结果 fallback 失败；最终通过既有隔离 restore fixture 构造异常，保留生产约束并明确验证正常写入仍被拒绝。没有通过删除或放宽生产约束取得测试通过。

独立初审及唯一验证审均已完成，发现已修复，不启动第三轮审查。PR #1591 仍需新提交的 exact-head CI 和合并条件；此记录不代表已部署。真实 provider 输出质量不属于本次离线契约验证结论。

## GitHub 后续 P1：完整的历史来源

PR comment `4206851930` 指出，已完成结果投影只冻结题面，仍从可变 question 读取知识点与草稿状态。正常 `editQuestion` 修改这些字段后，历史结果可能消失、ack 失败或报告计为 corrupt。父线程源码核对后接纳该 finding；通过正式编辑入口的三条回归（正确、错误、连续复验）已实际 RED，日志 `/tmp/yuk1364-completed-provenance-red-full.log`。

修复 `b7badc0bc` 已建立 Agency 拥有的已完成结果来源契约，由 Shell 与共享 evidence fold 消费。冻结 proposal/issuance/revision 决定历史题面和归属；原生结果的 submission/evaluation ID 必须指向同一次正式发题的已完成、无辅助自动评分。正常编辑 KC、draft、kind、choices 或题面不再重写历史事实。当前新作答准入、历史未发题语义、真实来源身份损坏及证据撤销规则保留；GET 无补写。

三条完整链路 RED→GREEN；最终 14 文件 299 DB、5 文件 72 unit、typecheck/lint/build 通过（297 lint warnings）。父核对五文件 SHA256 与交还一致，独立复跑 issuance、Scout、accountability 三文件 94 DB 通过，日志 `/tmp/yuk1364-parent-completed-provenance-db.log`。准确命令、哈希和消费者说明见 `/tmp/yuk1364-completed-provenance-commands.log`。

主线 P0 gate `42987dfd7` 已正常合入 `67f465e79`，仅看板和历史交接文档发生冲突。合并后冻结依赖安装、104 DB（含 P0 进程恢复）、74 unit、typecheck/lint/build 与 diff check 全部通过；日志 `/tmp/yuk1364-main-{install,db,unit,typecheck,lint,build}.log`。旧 head `eb0e5f53b` 的 CI 不能作为新修复的合并依据。

边界：旧 issued 记录没有原生 assessment refs 时保留冻结 issuance/revision 的历史契约；Scout 按 KC 发现候选的查询仍以当前 question 标签筛选，这与共享 fold 的已发现结果有效性校验不同，本修复未更改其发现语义。未发现需另建票的已证实缺陷；本轮 actionable finding 已在 YUK-1364 内闭环。以上是隔离 DB、离线执行端和本地构建证据，不是 provider 质量、CI 或 live-runtime 验收。该任务修复既有 finding，未启动第三轮审查，未部署或变更运行库。


## 主线依赖升级后的集成

`a6da290a7` 的 exact-head CI（含全部DB分片、migration smoke和production build）已通过，review thread均已裁决；随后main合入PR1584引发看板/交接文档冲突，故没有合并旧head。正常集成main `26f101581` 为 `b62c01dc6`，代码和锁文件没有手工冲突裁剪。

合并后的冻结安装、15文件309 DB（299相关回归 + 10项P0进程恢复）、6文件74 unit、typecheck/lint/build和diff检查全部通过；日志 `/tmp/yuk1364-deps-main-{install,db,unit,typecheck,lint,build}.log`。新提交仍需重新通过exact-head CI及合并条件。

旧a6da290a7的ARM64候选镜像已构建并核对revision，image ID `sha256:968e3c3861727ff51eab7319ba51116b100280f2e2e46d6909379bad762c9544`；它不含这次依赖集成，不能冒称当前head的发布镜像。运行验收尚未启动：部署互斥锁归YUK-1365其他线程，本线程mkdir被拒绝，没有删除锁或启动服务。


## ac4 候选的隔离运行基线与新 P1

`ac4b0f265` exact-head CI 全绿，但 GitHub comment `4207603575` 新指出 active brief 缺少冻结评分依据与原 proposal 的一致性校验。旧 probe 若在首次正式发题前改写 reference，可能展示并消耗判题调用，完成后才被 `probe_reference_mismatch` 拒绝。父已核对 active 与 completed 校验差异，implementation writer 正在补完整复现与共享 Agency 准入修复；不能合并此 head，不启动第三轮独立 review。与 main `df08399ff` 的预检冲突仅为 PLAN 和交接文档，尚未在 writer 工作中执行合并。

1365 owner 显式释放后，13:51Z 重新核对锁不存在并原子获取；同时实读 current-release 为 `df08399ff` / `sha256:28f89c8b2b9db63eeb311f92b9cef68528fab25232bbf0f596c6e4cd4fc1e214`，用途 Agent TEST ONLY。主服务未改。候选 `sha256:fbe24bc65bba8b9c975de976da286a6b1d026c3d64d209707daba641925b5963` 的 revision 为 ac4、ARM64。

独立 `yuk1364_acceptance` PG 使用已在本机的 `sha256:00ba258a66dac104fd5171074a0084462a64a1369d8513f3d0a634e2f24d15bc`，通过候选镜像 migrator 和既有 epoch CLI 激活；不恢复主库数据。Docker internal 网络阻断外网，不配置付费模型或启动 worker。该网络下端口未发布，HTTP 通过容器内 Node fetch 访问真实监听端口。首次测试 app URL 未指定 sslmode=disable，DB client 要求 TLS 而得到 ready503；仅重建自有 app 补上参数后 ready200/epoch active、缺 token401、空 brief200。

证据目录：`/Volumes/YukovalSBak/yukoval-projects/tlp-local-prod-20260907.sjUaCU/yuk1364-preflight-ac4b0f265/evidence/`，文件 `acceptance-migrate.log`、`acceptance-epoch.log`、`http-initial.json`、`http-ready.json`。这是旧候选的隔离基线，不是新 P1 的修复或最终运行验收，也不是主环境部署。


### ac4 隔离业务基线完成，14:03Z 释放锁

真实候选 HTTP 已验证：未发题探针不成为 `answer_probe`，直接提交返回409 `probe_not_issued`；正式 issuance 后 `probe_ready`。修改当前题面与发布新 revision 后仍返回原冻结题面；暂停 lifecycle 后退回其他 finding。正式发题后的 GET 前后，question/event/issuance/revision/lifecycle/knowledge/submission/evaluation 八表快照 digest 一致。

通过业务函数写入的**合成历史完成结果**（没有原生 assessment refs、未调用模型）在正常 `editQuestion` 修改 KC/draft/kind/choices/内容后仍为 `outcome_retired`。真实 ack HTTP 对缺失结果404、首次确认201、重试200，SQL快照只有一条对应确认事件。不能据此宣称真实模型输出、原生评分链或新 rubric P1 已通过。

一次性 fixture 由现有测试业务步骤整理，父核对后从准确 ac4 源码归档打包，避免读入并行修复。初次 fixture 的 user actor_ref 错误导致写入在 proposal 后中断；改为既有事件契约要求的 self 后，使用新 run ID 继续，失败数据未被清空。残留 proposal 因而产生合法 finding fallback，原“brief必须null”的断言不适用，实际验收条件是未发题不能成为可答题，已核对返回体。首次bundle目录没有依赖解析入口也已修正；以上均为验收脚本问题，未修改产品约束。

最终证据为上述目录内 `baseline-summary.json`、`http-unissued.json`、`http-issued.json`、`http-frozen.json`、`http-suspended.json`、`http-edited-completed.json`、`http-ack.json` 和 `fixture-ac4c-*.json`。14:03:33Z 停止并删除自有 app/PG/migrator、匿名测试存储和internal网络后，核对主release仍为28f、四个主服务健康，再仅删除本线程owner.json并rmdir释放锁；`lock-release.json`留证。已明确通知1365与主线线程，后续发布需它们重新核验取锁。新的 P1 修复仍在进行，此后本线程只做源码/文档。


## 冻结评分依据 P1 修复与主线再集成

`4207603575` 已实际 RED：旧 probe 在 withheld 时通过正常编辑修改 reference，再首次正式发题，旧代码展示该题并返回200，执行端被调用一次，写入submission/evaluation和claim。修复 `3d1134bbf` 抽取 Agency `validateIssuedProbeProvenance`，由 active brief、评分前准入与 completed provenance 共用；冻结 rule_reference/probe_spec 必须匹配原始 proposal，错误在构造评分执行端和写claim之前以409拒绝。已完成结果另保留原生assessment绑定校验。

legacy错误reference与native probe-spec题面/reference漂移均覆盖；合法legacy/native路径、正常编辑后的已完成历史和撤销语义保留。API旧fixture的缩略参考与proposal完整参考原本不一致，现改为同一原始完整参考，不降低生产校验。Postman仅更新该端点说明并重新生成，无请求形状改变。

writer最终9文件191 DB、4文件72 unit、typecheck/lint/build、API contract及capability boundary audit通过，297既有lint warnings。父核对20项source/patch/log SHA-256一致，读取实际diff及红测；准确命令和日志hash在 `/tmp/yuk1364-rubric-repair-evidence.md`。本次是实现修复，未增加第三轮独立review。

正常合入 main `6e54da8df`（包含1365 PR1593/1594）为 `50954a9c4`，冲突仅PLAN/历史交接，保留有效owner边界和最新优先级。合并后父独立运行4文件124 DB、5文件77 unit及typecheck/lint/build，全部exit0；日志 `/tmp/yuk1364-parent-rubric-merge-{db,unit,typecheck,lint,build}.log`。另运行API startup scoped unit，结果见同前缀`startup.log`。

14:11Z实读主release已为6e54da8df/build765c61f/imagefd8c046b97fe，Agent TEST ONLY，验收范围记录为部分：即时生命周期SSE已确认，真实正文因provider429限额未完成；没有代为重试或重放DLQ。新修复head尚未部署或完成容器HTTP复验；ac4旧基线不能替代它。


## 完整评分契约 P1 修复与父验收

GitHub comment `4208030193` 指出冻结 `probe_spec` 只比较 prompt/reference，仍允许 gold、target-error signature、response mode、elicitation 等评分字段偏离原 proposal。父核对后接纳，修复提交 `9d962371f`。所有来源加载器传递初次与复验的完整原始 spec；Agency 共享校验按 sequence 选择契约，以既有 canonical serializer 比较全部 schema 解析后的字段。单侧缺失 native spec 同样拒绝。Prep Desk、TeachingBrief、评分准入和已完成结果使用此校验；评分响应模式从原 proposal 读取。legacy 契约和正常编辑后的历史证据语义保留。

原实现完整契约漂移 RED 为14失败；封存原 validator 的定向 RED 为4失败，其中两条作答返回200并实际调用一次执行端、各写入一条 claim/submission/evaluation。相同定向修复后4通过。新增79条数据库用例覆盖两个 sequence、五种响应模式、字段/嵌套签名漂移、契约缺失、completed evidence/report/ack 与合法历史编辑。45条负向请求均返回409，执行端、claim、submission、evaluation、task-run增量均为0，八表快照保持一致。

writer最终270 DB、136 unit、typecheck/lint/build及boundary/API/partition audits通过。父核对9项源码、21份日志和8项封存材料的SHA256，并重新运行 complete-spec、probe-answer、prep-desk 三个DB文件，113/113通过，exit0。父日志 `/tmp/yuk1364-complete-spec-parent-db.log`；完整清单 `/tmp/yuk1364-complete-spec-manifest.json`。新测试使用真实隔离Postgres和Request/Response处理函数，模型执行端为脚本替身，没有付费调用。这不等于监听HTTP、镜像或真实模型质量验收。

先前66e候选的隔离监听HTTP已验证错误reference拒绝、冻结题面、正常编辑后的合成历史结果及幂等ack，14:18Z清理自有服务并释放锁；该旧证据不覆盖本次完整spec修复。当前新head仍待exact-head CI、镜像隔离HTTP及发布门禁，不启动第三轮独立review。旧66e发布脚本已加拒绝执行保护，未执行。当前actionable finding归既有YUK-1364，无需另建重复票。


## 9a43085a0 准确镜像隔离 HTTP 验收

从干净git archive构建ARM64镜像 `sha256:d4c166346ad796c18635a216a1d6c1ced6c9d021caebb89e60053320002f1f0a`，revision label与 `9a43085a07672608d3acc3f6e7a28c3adb14df79`一致。15:09:10Z实际核验并原子取得部署锁后，启动独立internal网络、PG与app，没有发布宿主端口、配置provider凭据或启动worker。候选migrator通过，既有epoch CLI激活assessment-contract-v1。真实HTTP readiness200、缺token401。

同一镜像验证legacy未发题不展示且answer409；正式发题后显示冻结题面；正常编辑当前题面后prepared_action不变，读取前后九表快照相同。通过业务函数写入的合成历史结果在后续正常编辑后保持outcome_retired；ack首次201、重复200，仅一条确认事件。该历史fixture没有原生assessment refs，不是成功原生评分证据。

native fixture通过正式publication在首次issuance前只改target_error_response_signature，保留原proposal、question metadata、prompt/reference；父逐字段核对初次和复验两个sequence确实只有该评分字段漂移。两者均被真实brief/probes排除，answer返回409 probe_spec_mismatch。未发题native返回409 probe_not_issued。合法原spec的sequence2仍显示正确冻结题面。各HTTP窗口的22张相关表全量快照完全相同；judge-started事件、submission/evaluation/task-run/provider-attempt/cost记录为空。没有调用合法native作答的provider路径；合成package/admission不构成真实模型质量或原生评分完成验收。

15:18:17Z停止并移除自有app、PG及匿名volume、internal网络，重新核对owner后释放deployment.lock，显式通知1365与主线。主release仍为6e54da8df/imagefd8，四服务healthy，没有修改主库。证据根为runtimeRoot/yuk1364-preflight-9a43085a0/evidence，acceptance-summary.json、lock-release.json及evidence-sha256.json封存实际结果。

合并前发现CI Gate 37642044307整体failure，已生成16个job均success或合法skip，最后汇总gate未生成，无failed-step日志。GitHub拒绝一次failed-only retry；改用现有workflow_dispatch在相同head触发37643395029完整gate。根因尚未确定，不能以部分绿色代替完整gate；此记录不代表已合并或部署。

手动完整CI `37643395029` 随后在准确9a43085a0全部通过，包含最后汇总job；本地与镜像证据未变。然而普通expected-head squash仍被base policy拒绝。规则要求GitHub Actions汇总context；REST核对head上该context为success，PR临时merge commit `598d76c545ed186e5ac77acd5021c5d52ddd2338`无check-runs。未使用admin或修改规则。将本次实际验收文档提交到PR，以新的pull_request事件重新取得规则认可的CI，旧工作流失败记录保留。


## 2026-10-07 15:50Z 历史 V1 兼容性修复

70bd102bd 的 PR CI 37645299169 全绿，但 GitHub P1 4208871927 经源码核实成立：V1 schema 不含 schema_version，normalizer 将其转成 legacy rule-reference，不保存 V2 的 criterion.probe_spec。现 validator 以原始 spec 非空为条件要求 native 冻结字段，误拒合法 V1。唯一 writer 正在建立 absent/V1/V2 与各消费者的兼容矩阵并补回归，当前不能合并或发布。既有 9a HTTP 和 70b 制品一致证据不覆盖这次待完成修复。

P2 4208871942 的 LIMIT-before-validation 已源码确认，运行影响尚未复现。去重后登记 YUK-1374；本 PR 延期该 P2，不声称修复。运行环境未改动，主线与 1365 owner 已收到状态通知。


## 2026-10-07 16:00Z schema audit 基线归因

父解析修复前70bd准确归档与修复后的canonical JSON，结构完全相等：885字段结果、731未豁免stub、119allowlisted、0allowlistIssues。实际脚本用绝对路径运行test/spec过滤，工作树名test-storage匹配test-，使生产源码被误排除；同一probe-lifecycle.ts相对路径不匹配而绝对路径匹配。已登记YUK-1375独立修复，不扩当前PR或allowlist。首次/tmp归档执行只有Command行而无audit输出，不计通过；/private/tmp规范路径运行取得真实失败JSON。证据 /tmp/yuk1364-v1-compat-audit-schema-current-json.log 与 /tmp/yuk1364-v1-compat-audit-schema-base-canonical.log。本项不能称为schema audit绿色。


## 2026-10-07 16:02Z V1 修复交回

代码faf2e66b012e3725df533189e58ad2dab31de188仅改变共享validator及两测试文件。通过schema-owned V2 safeParse区分V1和V2；V1/无spec沿用原始sequence的冻结prompt/reference，任一侧含V2仍要求完整契约相等。21项新V1 DB覆盖两个sequence、真实publisher/issuance、scripted executor作答、正常edit后的native及历史结果、ack幂等、report、recurrence与correction fold、错误参考/题面、V1/V2交换及坏proposal拒绝。修正测试fixture SQL数组错误后的RED为7个实际兼容性失败，另两个坏proposal控制通过；保留初始失败日志。

最终281 DB、82 unit、typecheck/lint/build及10项audit通过。父核对23日志hash与20构建时源码hash；schema audit限制见上节YUK-1375。writer已释放。父重点两文件100 DB已通过，日志/tmp/yuk1364-v1-parent-db.log；新head CI/镜像HTTP仍待完成，不把旧镜像验收延伸到本修复。完整证据/tmp/yuk1364-v1-compat-evidence.md、manifest.json、final.patch。
