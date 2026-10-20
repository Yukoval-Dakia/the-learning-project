# 旧 API alias 退役 — 21 条 route 注册移除

执行依据：协调批准清单 `parent-api-removal-list-for-coordinator.md/json`
（清单 SHA256 `37ee3655e3bf544a888a4692660246c1de66a9c041cbbe8c6c6fbfb5f287c4ee`，
固定源码 revision `4fd179818bd4a3ad8f16c07b2c9f38daa1adc259`）。实施基线
`origin/main = 1be6fba10a7fa5f014dd820d468b20227e0f8000`。

## 改动面

- 21 条旧 method+path 的 manifest route 注册移除（route-only 注销；不再接受 HTTP 流量）：
  - ingestion `manifest.ts`：`POST /api/ingestion/[id]/extract`、`POST /api/ingestion/[id]/import`
  - practice `manifest.ts`：`POST /api/review/{submit,appeal,sessions}`、
    `POST /api/review/sessions/[id]/{pause,resume,end,reopen}`、`POST /api/placement/start`、
    `POST /api/placement/[id]/{next,end}`、`GET|POST /api/practice`、
    `POST /api/practice/[id]/{submit,answer}`、`POST /api/questions/[id]/solve`、
    `POST /api/questions/[id]/solve/[sid]/{submit,hint}`
  - shell `manifest.ts`：`POST /api/proposals/[id]/{decide,retract}`
- 孤立 alias 模块删除 10 个（仅被对应 manifest `load` thunk 引用，无其他 importer）：
  `ingestion/api/{extract,import}.ts`、`practice/api/{legacy-review-sessions,session-pause,
  session-resume,session-reopen,placement-end,legacy-practice}.ts`、
  `shell/api/{proposal-decide,proposal-retract}.ts`
- manifest 内随删除悬空的 schema imports 同步清理（14 个符号；contracts 源文件不动）。
- `postman/api-endpoints.json`：3 条旧 placement spec（`/api/placement/start`、
  `/api/placement/:id/next`、`/api/placement/:id/end`）移除；`pnpm gen:postman` 重生
  collection（36 folders / 94 paths / 101 requests）。
- `src/ui/lib/api-schema.generated.ts` 经 `pnpm gen:api-client` 重生：171→151 path 条目，
  净删恰为本批 20 个 path 块（21 method，`/api/practice` 单条目含 GET+POST）。
  该文件是 CI `audit:api-client`（regen + `git diff --exit-code`）强制的同步生成物。

## 逐字保留（原表「只去 route 注册」项）

`practice/api/{submit,appeal,session-end,placement-start,placement-next,paper-submit-route,
paper-answer-route,solve-start,solve-submit,solve-hint}.ts` 模块与全部导出原样保留——
canonical 资源函数（`createAttemptResource`/`createAppealResource`/`createPlacementSessionResource`/
`createPlacementQuestionSelection`/`createPaperSubmission`/`createAnswerDraft`/`createSolveSession`/
`createSolveSubmission`/`createHintRequest`）与兼容 re-export（`enqueueReviewSessionSummary`）
继续被 canonical route / `resource-routes.ts` 消费；`submit.ts` 的 `POST` 仍被
`src/server/advisory-locks.db.test.ts` 直引，`import.db.test.ts` 不经 `api/import.ts`
（走 `import-completion`/`operation-store`/`import-schema`，均保留）。

## 明确不动的边界

- canonical 执行器全留：`review-session-detail.ts`（PATCH transition）、
  `placement-session-detail.ts`、`operations.ts`（ingestion operations 派发）、
  `proposal-decisions.ts`、`server/proposals/actions.ts`、`import-completion.ts`、
  `import-schema.ts`（测试仍用 `ImportBody`）。
- 保留项逐字未动：UI B 4 条（knowledge proposals/edge-proposals/misconception-veto、
  events/correct）、`GET|POST /api/ingestion`、`make-paper`/`rescue`（worker job 直引）、
  `GET /api/practice/[id]`、9 条 Start HTTP 回退、`/api/health`、`/api/ready`、
  SPA→Start document 交接与 query/hash。
- `POST /api/questions/[id]/solve/[sid]/submit` 的特别说明：其 canonical
  `POST /api/solve-sessions/[sid]/submissions` 的 UI 同样没有入口——不是
  「UI 已迁移」；canonical 服务端执行器（`createSolveSubmission` → resource-routes）
  保留。该行限制请协调单独审看。

## 验证与限度

- 本机执行：`pnpm typecheck`、`pnpm lint`（178 warnings，与 main 基线一致）、
  `pnpm build`（web + server/worker/migrate cjs）、`pnpm gen:postman`、
  `pnpm gen:api-client`（重生确定性已核：二次运行 SHA256 不变）。
- 只读 audit 通过：`schema`、`partition`、`draft-status`、`test-policy`、`task-census`、
  `profile`、`api-contracts`（160/160 declared，0 legacy）、`api-client-usage`、
  `dependencies`（10 既有漏洞计数不变）、`question-writers`、`tool-params`、
  `learner-copy`、`no-learning-styles`、`structured-judge`。
- `audit:capability-boundaries` / `audit:architecture-deepening` 报「debt 下降需
  tighten」：ingestion→boss 8→7、ingestion→session 9→8、shell→proposals 4→2，
  capability→server 总 420→416。`scripts/capability-boundary-baseline.json` 按指令
  未动，留待父按最新 main 实测收紧。
- `audit:api-client` 在本工作树报 diff 属预期（生成物未提交时 `git diff` 非空）；
  commit 后 exact-head CI 该门应为绿。
- 消费者复核（最新 main）：frontend/Start/worker/scripts/MCP/Postman 无 21 条的
  HTTP 调用、动态拼接或直接 handler import；10 个删模块仅被 manifest `load` 引用。
  开放 PR diff（#1882–#1888、#1872/#1873、#1857、#1866/#1867、#1797、#1802）无旧路径
  引用；#1797 与 `practice/manifest.ts` 同文件但 hunk 不重叠（其改 1366–1563 行
  proposalKinds 区）。`_work`/`tlp-status`/`tlp-local-prod`/`nas-maintain` 只读扫描
  无真实调用者（命中均为冻结证据/打包注释/kept 路由）。ops canonical 目录扫描待父
  转达 ops 答复后补。
- 运行时对齐 NOT_RUN：无本机 tests/DB/provider/paid/runtime/deploy 验证；静态
  route-removed 证明不冒称运行 parity。
- 逐条消费者重核表、校验日志、保留文件 byteproof 与 removed-paths 清单外置：
  `tlp-audit-artifacts/architecture-deepening/retired-api/<commit-fullSHA>/`（仓库外）。
