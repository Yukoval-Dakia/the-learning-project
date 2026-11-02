# 旧 API alias 退役 — 21 条 route 注册移除

执行依据：协调批准清单 `parent-api-removal-list-for-coordinator.md/json`
（清单 SHA256 `37ee3655e3bf544a888a4692660246c1de66a9c041cbbe8c6c6fbfb5f287c4ee`，
固定源码 revision `4fd179818bd4a3ad8f16c07b2c9f38daa1adc259`）。实施基线
`origin/main = 1be6fba10a7fa5f014dd820d468b20227e0f8000`，后普通 merge
`origin/main = 671e080445e3d8acef0f2f4db3ae972ebd7ef556`（含 #1797 YUK-1407、
#1872 YUK-1622、#1886、#1888；merge 无冲突，21 条移除与 #1797 proposalKinds
改动各居不同 hunk，互不干扰）。

## 改动面与计数对账（21 = 10 route-only + 11 删模块）

- **route-only（10 个 method，仅删注册，模块逐字保留）**：
  `POST /api/review/submit`、`POST /api/review/appeal`、
  `POST /api/review/sessions/[id]/end`、`POST /api/placement/start`、
  `POST /api/placement/[id]/next`、`POST /api/practice/[id]/submit`、
  `POST /api/practice/[id]/answer`、`POST /api/questions/[id]/solve`、
  `POST /api/questions/[id]/solve/[sid]/submit`、
  `POST /api/questions/[id]/solve/[sid]/hint`
- **删注册 + 删孤立 alias 模块（11 个 method，10 个文件）**：
  `POST /api/ingestion/[id]/extract`、`POST /api/ingestion/[id]/import`、
  `POST /api/review/sessions`、`POST /api/review/sessions/[id]/pause`、
  `POST /api/review/sessions/[id]/resume`、`POST /api/review/sessions/[id]/reopen`、
  `POST /api/placement/[id]/end`、`GET /api/practice` 与 `POST /api/practice`
  （同一 `legacy-practice.ts` 两 method）、`POST /api/proposals/[id]/decide`、
  `POST /api/proposals/[id]/retract`
- 删除的 10 个 alias 模块：`ingestion/api/{extract,import}.ts`、
  `practice/api/{legacy-review-sessions,session-pause,session-resume,session-reopen,
  placement-end,legacy-practice}.ts`、`shell/api/{proposal-decide,proposal-retract}.ts`
  （各仅被 manifest `load` thunk 引用，共 314 行）。
- manifest 内随删除悬空的 schema imports 同步清理；contracts 源文件不动。
- `postman/api-endpoints.json`：3 条旧 placement spec（`/api/placement/start`、
  `/api/placement/:id/next`、`/api/placement/:id/end`）移除；`pnpm gen:postman` 重生
  collection（36 folders / 94 paths / 101 requests）。
- `src/ui/lib/api-schema.generated.ts` 经 `pnpm gen:api-client` 确定性重生：
  paths 171→151、operations 185→164，净删恰为本批 20 个 path 块 / 21 个
  operation（`/api/practice` 单 path 含 GET+POST）；added/changed 均为 0，
  components/webhooks/$defs 各成员不变（父 AST 对比已独立核实，
  见其 `parent-generated-schema-diff.json`）。该文件是 CI `audit:api-client`
  强制的同步生成物，只含 route/operation 对应差异，无手改 UI。

## 逐字保留（route-only 项的模块与导出）

`practice/api/{submit,appeal,session-end,placement-start,placement-next,
paper-submit-route,paper-answer-route,solve-start,solve-submit,solve-hint}.ts`
模块与全部导出原样保留——canonical 资源函数
（`createAttemptResource`/`createAppealResource`/`createPlacementSessionResource`/
`createPlacementQuestionSelection`/`createPaperSubmission`/`createAnswerDraft`/
`createSolveSession`/`createSolveSubmission`/`createHintRequest`）与兼容
re-export（`enqueueReviewSessionSummary`）继续被 canonical route /
`resource-routes.ts` 消费；`submit.ts` 的 `POST` 仍被
`src/server/advisory-locks.db.test.ts` 直引；`import.db.test.ts` 不经
`api/import.ts`（走 `import-completion`/`operation-store`/`import-schema`，均保留）。

## 明确不动的边界

- canonical 执行器全留：`review-session-detail.ts`（PATCH transition）、
  `placement-session-detail.ts`、`operations.ts`（ingestion operations 派发，
  其注册与 responseSchemas 均未动；YUK-1522 线未提交的 503 增补不属本批，
  后合时保留）、`proposal-decisions.ts`、`server/proposals/actions.ts`、
  `import-completion.ts`、`import-schema.ts`。
- 保留项逐字未动：UI B 4 条（knowledge proposals/edge-proposals/misconception-veto、
  events/correct）、`GET|POST /api/ingestion`、`make-paper`/`rescue`、
  `GET /api/practice/[id]`、9 条 Start HTTP 回退、`/api/health`、`/api/ready`、
  SPA→Start document 交接与 query/hash、8 项 pre-AI、`sessions.ts`、
  kind=agent operations/operation-store/预算/server-agent 文件。
- `POST /api/questions/[id]/solve/[sid]/submit` 特别说明：其 canonical
  `POST /api/solve-sessions/[sid]/submissions` 的 UI 同样没有入口——本行不是
  「UI 已迁移」的证据；canonical 服务端执行器（`createSolveSubmission` →
  resource-routes）保留。该行限制请协调单独审看。

## 静态消费者复核结果（非运行时证明）

- 仓内：frontend/Start/worker/scripts/MCP/Postman 无 21 条的 HTTP 调用、
  动态模板拼接或直接 handler import；10 个删模块仅被 manifest `load` 引用。
  开放 PR diff 无旧路径引用；#1797 与 `practice/manifest.ts` 同文件但 hunk
  不重叠（其改 proposalKinds 区，merge 时已无损并入）。
- 仓外只读扫描（未执行任何脚本/容器/daemon）：`_work`、`tlp-status/review`、
  `tlp-local-prod`、`nas-maintain` 及父转达的 ops canonical 清单。
  ops 面真实 HTTP 调用 6 处全部指向保留路由：`GET /api/questions/<id>` ×2、
  `POST /api/worksheet-exports`、`POST /api/review-sessions`（canonical）、
  `GET /api/ready`、`PATCH /api/questions/<id>`、`POST /api/issuances`、
  `POST /api/attempts`；21 条命中 = 0。
  - `ops-context/cancel-unsent.cjs`（78 万行 bundle）内的
    `path: "/api/review/submit"` 等字面量是 esbuild 打包进产物的 server manifest
    路由表（注册条目），不是出站 HTTP caller；`DELIVERY_API_BASE` 仅声明未消费。
  - `formal-cancel-01`/`release-20261020-01` operator 动态 import 的
    `/tmp/yuk1573-deploy.py`、`/tmp/yuk1567-dc42-restore.py` 现已不存在——
    封存 helper 不能当作当前 runtime 字节完整证明，如实记录为 missing
    reference；可见 call site 只引用保留/canonical 路径。
- 剔除项：无。21 条全部维持移除。

## 验证（本机允许集内；运行时对齐 NOT_RUN）

- 执行：`pnpm typecheck`、`pnpm lint`（0 error，177 warnings ≈ main 基线）、
  `pnpm build`（web + server/worker/migrate cjs）、`pnpm gen:postman`、
  `pnpm gen:api-client`（确定性双跑 SHA256 不变）、`pnpm audit:api-client` 已绿。
- 只读 audit 通过：`api-contracts`（160/160 declared，0 legacy，151 paths）、
  `api-client-usage`、`schema`、`partition`、`draft-status`、`test-policy`、
  `task-census`、`profile`、`question-writers`、`tool-params`、`learner-copy`、
  `no-learning-styles`、`structured-judge`、`dependencies`（10 既有计数）。
- `capability-boundaries` / `architecture-deepening`：经 `--tighten` 登记真实减少
  （capability→server 420→416；ingestion→boss 8→7、ingestion→session 9→8、
  shell→proposals 4→2）。`capability-boundary-baseline.json` 的 `notes` 已注明
  减少来源是删除 alias 间接边，不是新算法深化；audit 脚本/CI 未动。
- **NOT_RUN**：本机 tests/DB/provider/paid/runtime/deploy/`tsx -e` 全部未运行；
  以上为静态验证结果，不冒称运行时 parity 或外部 consumer 验收。
  Docker/OrbStack daemon 全程未触碰。
- 本文是实施自报，不构成独立 review；R1+R2 由父统一组织。

## 外置证据（仓库外，未覆盖旧 seal）

- `…/architecture-deepening/retired-api/49254b75b31521f4f6bae0658788d5ea44b47a3a/`：
  合并前批次（21 条逐条 consumer 表、校验日志、byteproof、removed-paths、
  父 `parent-generated-schema-diff.json`）。
- `…/architecture-deepening/retired-api/<final-head-fullSHA>/`：合并后批次
  （ops 补核逐文件记录、准确计数表 v2、tighten 后校验日志）。目录名取
  本 doc 所在分支最终 head；父以最终 head 自定位。
