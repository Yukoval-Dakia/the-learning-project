# src/capabilities/observability — AI 可观测性

> admin 四页数据面（runs / cost / failures / subjects）+ 今日成本条 + 备份恢复/事件撤回/通用 job SSE tracker。纯读或受控写，不跑业务逻辑。

## WHERE TO LOOK
| 文件 | 职责 |
|------|------|
| `manifest.ts` | 11 条 API 路由 + admin 四页 ui.pages |
| `api/admin-runs.ts` / `admin-run-detail.ts` | AI task runs 列表与时间线 |
| `api/admin-cost.ts` / `cost-today.ts` | cost 汇总与今日成本条 |
| `api/admin-failures.ts` | failure 聚类 |
| `api/admin-subjects.ts` | subject registry 只读视图 |
| `api/calibration-maturity.ts` / `effectiveness-trend.ts` | 成效趋势只读面 |
| `api/backup-export.ts` / `backup-import.ts` | 备份/恢复（破坏性，需 confirm） |
| `api/event-correct.ts` | 统一事件流撤回 |
| `api/job-events.ts` | 通用异步 job SSE tracker |
| `server/` | AI observability 读模型、cost 汇总、failure 聚类、备份/恢复、event correction |
| `ui/observability.tsx` / `ui/subjects.tsx` | admin 四页 React 面 |

## CONVENTIONS
- admin 路由照常套主 chrome（`web/src/router.tsx` RootShell）；不另设 admin 独立壳。
- `/api/jobs/[kind]/[id]/events` 是通用异步 job SSE tracker（copilot_run 首个消费者）。
- `/api/events/[id]/correct` 是统一事件流撤回面（correction 内核不变量）。
- cost 按 task / provider / model 聚合；R2/S3 成本按 currency 分组不能直接相加。

## ANTI-PATTERNS
- 别把可观测性路由当业务入口；这里只读或做受控运维动作。
- 备份恢复是破坏性动作，必须显式 confirm；别在普通业务代码里调用。
- event correct 不是编辑历史；它是留痕的撤回/修正事件。
