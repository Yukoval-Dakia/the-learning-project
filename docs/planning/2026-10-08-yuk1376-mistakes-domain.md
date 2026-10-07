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
