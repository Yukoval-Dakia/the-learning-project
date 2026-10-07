# YUK1376 错题读取迁移

实现提交：`d231403441345b7a6936cec10157df741d69c955`，基于main `36f719675`。状态：实现交回、父DB通过；独立review及exact-head CI待完成。未部署，未核销Start挂载或旧SPA退出。

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
- 独立初审task `yuk1376-independent-review-20261008-v1`，codex/gpt-6.1-sol/xhigh，只读固定d23140344，尚待结果。无第三方review完成宣称。

本线程拥有领域交付、PR和1359证据；主线57961995拥有Start组合根挂载及1352/55/56集成。无部署锁或runtime操作，无付费provider，无DLQ重放。三项修复已纳入1376；1243仍独立Backlog，native完整投影是尚未核销的迁移验收边界。
