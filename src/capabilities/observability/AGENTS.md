# src/capabilities/observability — AI 可观测性

> admin 五页数据面（runs / cost / failures / subjects / coverage-lattice）+ 今日成本条 + 备份恢复/事件撤回/通用 job SSE tracker。纯读或受控写，不跑业务逻辑。

## WHERE TO LOOK
| 文件 | 职责 |
|------|------|
| `manifest.ts` | API 路由 + admin 五页 ui.pages |
| `api/admin-runs.ts` / `admin-run-detail.ts` | AI task runs 列表与时间线 |
| `api/admin-cost.ts` / `cost-today.ts` | cost 汇总与今日成本条 |
| `api/admin-failures.ts` | failure 聚类 |
| `api/admin-subjects.ts` | subject registry 只读视图 |
| `api/coverage-lattice.ts` / `server/coverage-lattice.ts` | 供题治理覆盖细目表（YUK-579，`/api/admin/coverage-lattice`）：scanCoverageGaps 四规则的 KC 池级覆盖 + emitted 缺口 targets + 单条 `experimental:question_supply` 活动聚合。READ-ONLY，复用发现引擎 `assembleScanInput`（零新查询子系统）|
| `api/conjecture-scores.ts` | conjecture 判别探针 A4 双读 reader（`/api/admin/conjecture-scores`：`prediction_score` + auto-mint `kc_typed_state` confused-with-X，#13 通电） |
| `api/calibration-maturity.ts` / `effectiveness-trend.ts` | 成效趋势只读面 |
| `api/backup-export.ts` / `backup-import.ts` | 备份/恢复（破坏性，需 confirm） |
| `api/event-correct.ts` | 统一事件流撤回 |
| `api/job-events.ts` | 通用异步 job SSE tracker |
| `server/` | AI observability 读模型、cost 汇总、failure 聚类、覆盖细目、备份/恢复、event correction |
| `ui/admin-runs.tsx` / `admin-cost.tsx` / `admin-failures.tsx` | 三张独立 lazy admin React 面；共享 chrome/helper 在 `observability-shared.tsx`，`observability.tsx` 仅兼容 barrel |
| `ui/subjects.tsx` / `ui/coverage-lattice.tsx` | subject 与覆盖细目 admin React 面 |

## CONVENTIONS
- admin 路由照常套主 chrome（`web/src/router.tsx` RootShell）；不另设 admin 独立壳。决策记录见 `docs/design/2026-07-07-yuk579-coverage-lattice.md` §6（loom app.jsx 的「separate shell」原型已被 SPA 单一 RootShell 取代，owner 已收编；`docs/audit/2026-06-13-visual-gap.md` §5 决策点③ 收口）。
- `/api/jobs/[kind]/[id]/events` 是通用异步 job SSE tracker（copilot_run 首个消费者）。
- `/api/events/[id]/correct` 是统一事件流撤回面（correction 内核不变量）。
- cost 按 task / provider / model 聚合；R2/S3 成本按 currency 分组不能直接相加。

## ANTI-PATTERNS
- 别把可观测性路由当业务入口；这里只读或做受控运维动作。
- 备份恢复是破坏性动作，必须显式 confirm；别在普通业务代码里调用。
- event correct 不是编辑历史；它是留痕的撤回/修正事件。
