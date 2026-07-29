# 当前 handoff — 2026-07-29

## Active line

- YUK-823 正在收口 TypeScript 7 GA 性能：实现与本地 full pre-PR gate 已完成，下一步
  是 PR CI 首跑/同 head rerun 的 buildinfo cache 冷热对照、review 与 merge。
- YUK-820 已从 closeout 重新进入 In Progress：owner 指出 CI wall-clock 几乎未缩短，
  真实同代码对照确认 unit affected 生效但 DB 仍是关键路径；本 TS7 PR 触及 workflow，
  会按设计 full，不能充当 affected acceptance。
- fail-closed DB affected selector 已随 PR #1109 / squash `1df65fd7` 合并；YUK-820
  保持 In Progress，只等待下一条普通 server/API PR 的 live timing 验收。
- YUK-814 harness 已随 PR #1105 落到 main；真实 shadow/blind/canary 仍停在 production
  backup / 6–10 个合格真实 owner 失败簇输入闸门，不用 synthetic/mock 代替。

## YUK-823 当前证据

1. main 已使用 `typescript@7.0.2` 的 native `tsc`，不是从 TS6 新升级；缺口是
   `typecheck:legacy` 仍错误地指向同一个 TS7 binary、无 native watch script、CI 不复用
   `tsconfig.tsbuildinfo`。
2. full check 三轮中位数：TS7 5.73s、TS6 33.41s，TS7 为 5.83x；TS7 cold buildinfo
   5.32s，warm 三轮中位数 0.584s，为 9.12x。
3. TS7 `--checkers` 三轮中位数：1=5.70s、2=4.19s、4=3.66s、6=3.92s、
   8=4.96s、10=4.66s；默认等价 4 且最优，不固定更高值。
4. 正常代码 TS7/TS6 均零诊断；注入错误均为同一
   `zz-ts7-diagnostic-smoke.ts(1,7) TS2322`；TS7 watch 首轮 0 errors。

## YUK-823 实现

- `@typescript/native = npm:typescript@7.0.2` 提供 TS7 `tsc`；
  `typescript = npm:@typescript/typescript6@6.0.2` 恢复完整 compiler API 与 `tsc6`。
- `typecheck:legacy` 使用 `tsc6 --incremental false --stableTypeOrdering`，避免旧格式
  buildinfo 污染 TS7 cache；新增 `typecheck:watch` 使用 TS7 native watcher。
- CI static lane 缓存 `tsconfig.tsbuildinfo`：compiler/config hash 隔离兼容域，commit SHA
  隔离精确状态，restore prefix 允许从同配置最新状态增量恢复。
- 本地 full pre-PR：typecheck ×2、lint、standalone audits、`pnpm test`
  （5,891 unit / 4,263 DB / 26 migration）与 build 全绿。

## YUK-820 当前证据

1. Unit 真实失败 head 回放：21/21 捕获，覆盖 18 PR；20 affected、1 full fallback。
   早先 3 个表面 unit miss 经历史 inventory 证明均属于 DB partition。
2. PR #1108 affected run `30447000426` 对 main full run `30447542212`：unit step
   132→41s（-69%），runner time 1,070→905s（-15.4%），但 DB job 仍约 355s，
   wall 394/404s；所以 owner 的观察成立。
3. DB 真实失败 head 回放：20/20 捕获，覆盖 15 PR；纯 graph 初版 18/20，两个真实
   out-of-graph failures `quiz_gen.test.ts` / `propose_edge.db.test.ts` 已固化为 failure
   sentinels，重放后 0 miss。
4. #1108 exact tree：最终 selector 195/390 DB files；其 181-file 前序集合已跑两 shards，
   1,219+1,130 tests 全绿（另 3+6 skipped）；新增 dynamic-import sentinels 由 full suite 覆盖。
   本机并发 Testcontainers wall 不冒充
   GitHub runner 的节省值。
5. #1109 final head CI Gate `30452431101` 全绿且共享 selection artifact 为 full；DB shard
   test time 323.9s / 904.8s。第二 shard 相对同代码历史约 326s 是极端长尾，因此这条
   CI 只证明 full canary 正确，不用于宣称 affected wall-clock 改善。

## 实现

- `gate-plan.mjs` / workflow 新增 `db_selection=skip|affected|full`。
- `scripts/ci/db-affected.mjs`：Vitest changed graph + full historical inventory、direct-test
  guard、source-scanning/dynamic-import tests、failure sentinels、unsafe/empty/error full fallback、safe argv、
  empty-shard skip、per-shard execution artifacts。
- selector 在独立前置 job 只计算一次，两个 DB shards 下载同一 artifact；selector 进程
  失败时共享 full fallback，避免两个分片因模式分歧留下覆盖空洞。
- main push、schema/migration/config/workflow/kernel/core/unknown 与 selector 自身改动继续 full。
- 证据文档：
  - `docs/audit/2026-07-29-unit-selector-backfill.md`
  - `docs/audit/2026-07-29-db-selector-failed-head-backfill.md`

## 下一步

1. YUK-823 PR 首跑记录 Typecheck cold step；成功保存 cache 后 rerun 同一 head，记录
   cache hit 与 warm step，再完成 review/merge。
2. 下一条普通 server/API PR 用 DB selector artifacts + GitHub job timing 验收真实 wall；
   至少核对 requested/effective/required mode、selected files、两个 shard test time。

## Worktree / workflow 状态

- 当前 worktree：`/Users/yuqi/.codex/worktrees/9a32/the-learning-project`。
- 当前 branch：`codex/yuk-823-ts7-performance`（base `origin/main@de60be05`）。
- owner 主工作树仍在 `codex/yuk-812-agent-control-plane` 且有既存改动；本轮未触碰。
- `.ykv` 本地检索 cache 因 16.1 MiB chunks 文件会触发 Biome 1 MiB 上限，已移到
  `/tmp/yuk-823-ykv-cache` 后执行 lint；该目录由 Git info/exclude 排除，不进提交。
- full pre-PR：390 DB files / 4,263 tests、5,891 unit tests、migration 26/26、build、
  lint、TS7 typecheck、TS6 fallback 全通过；Testcontainers 已退出。
