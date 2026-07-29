# 当前 handoff — 2026-07-29

## Active line

- Architecture exit、Grounding 首切、YUK-804 均已合并。
- YUK-787 / YUK-795 已随 PR #1098 / #1101 合并并在 Linear Done；最终
  CI Gate / OCR / CodeQL 全绿。
- 当前唯一 active 线是 YUK-788：
  `codex/yuk-788-owner-feedback-loop`，PR #1102，基于 `origin/main@41fa2a07`。
- 已合入 GitHub CI 并行化及 DB/unit 长尾提速；不在本地
  重复跑 CI gate。

## 当前实现

1. nightly 保留 pending proposal 第一层去重；YUK-788 新增同 capability 内的
   owner decision / terminal history 第二层 gate。
2. 同 `(cause_category × knowledge_id)` 的 dismiss 冷却 30 天；accepted 但未 terminal
   的 conjecture 视为 active，不重复归纳。
3. confirmed/retired terminal 后只有至少两条 `created_at > terminal_at` 的有效
   failure attempt 才能 reopen；enrichment 删除缺失/变异证据后会以可复现 ids
   再验 fresh floor，不能用旧的 pre-terminal attempt 补足。
4. reopen 必须携带最近一次 accept/edit 后的 owner claim；edit 的
   `corrected_claim_md` 优先于原 proposal claim，并接入已有 `priorClaimMd`。
5. proposal/rate/result 查询仅覆盖今晚 candidate KC 并按 500 分块；terminal 活性复用
   correction-aware `getEffectiveProbeResultStatuses(..., validateDirectChain=true)`。
6. identity 最新决定只消费每个 proposal 的最新 rate；rollback 撤销旧 accept，且
   terminal 必须属于 identity 当前最新 accepted proposal，旧 proposal 的较晚结算不能
   错放仍 active 的新 proposal。
7. 没有新事件流、schema 或跨 capability 深层导入；nightly 只消费已有 proposal、
   rate、probe_result 与 attempt facts。

## 验证与远端

- YUK-788 已提交并推送为 PR #1102；实现 commit `7049cb07`。
- 定向 unit `research_meeting_nightly.unit.test.ts` 44/44 通过。
- closed-loop DB `research_meeting_closed_loop.db.test.ts` 18/18 通过，覆盖：
  dismiss cooldown、terminal 不重复归纳、两条新失败重开、owner rewrite 进入真实 prompt、
  stale accept 不压过新 dismiss、corrected rate 不再参与 fold、enrichment 不得以
  pre-terminal evidence 冒充 fresh reopen floor、旧 proposal terminal 不得结算新 accept、
  rollback 必须撤销旧 accept。
- `pnpm typecheck`、改动文件 Biome、`git diff --check` 已通过。
- main 新增 CI 并行 lanes：static/audits、unit、DB、migration、build、usability；
  aggregate 保留 required-check 名称并 fail closed。
- 只在本地跑改动范围的定向测试/格式检查；完整 gate 只监听 GitHub Actions/OCR。
- CI 方案说明：`docs/research/2026-07-28-ci-speedup.md`。

## 下一步

1. 只监听 PR #1102 的 GitHub Actions/OCR；处理远端失败或 review。
2. 全绿后合并，Linear YUK-788 对齐 Done。
3. 严格串行证据化收口 YUK-803（实现已在 YUK-785 落地，Linear 仍 Backlog）。
4. YUK-814 真实 owner 数据 shadow/blind gate 必须单独执行；mock 不能代替。

## CI 测试长尾二次提速（2026-07-29）

- 分支：`codex/yuk-817-ci-test-speedups`（基于 `origin/main@13c2b858`）。
- PR：#1100；GitHub run `30378606905` 全绿，独立 OCR review 的 clean-exit
  timeout classification 发现已修复并 resolve。
- YUK-817：`resetDb()` 的 54 条逐表 TRUNCATE 合为一条 multi-table TRUNCATE；
  CI DB lane 使用 Vitest `--shard=1/2`、`--shard=2/2` matrix，aggregate 仍 fail closed。
- YUK-818：Step9 invariant suite 对 `src/app/scripts` 建一次 immutable source snapshot；
  PfPaper autosave 测试只把 production 800ms timer 映射为 10ms，必须保持 pending
  窗口的 exit/pagehide 用例映射为 100ms；覆盖/断言不减。cold tsx CLI 测试在 full
  suite 的 scheduler contention 下放宽到 20s，隔离运行仍约 2–3s。
- YUK-819：JYEOO 在 POSIX 以独立 process group 启动，timeout kill 整组；新增
  grandchild 与 wrapper 已退出但后代仍持 stdio 的回归用例。Windows 保留 direct-child
  fail-safe。
- 验证：两 DB shards 覆盖 388 files（4,204 passed / 9 skipped / 1 todo）；unit
  509 files（5,781 passed / 33 skipped）；migration 26/26；typecheck、tracked lint、
  schema/dependency/partition/API/profile/copy/draft/hub-sync audits、build 全绿。
- GitHub 首个完整样本：DB shard 6m15s / 5m11s，对比旧 critical path 13m12s；
  unit 2m42s，前一轮 2m14s，对比旧基线 2m16s，未证明 20% median 改善。
- YUK-817/818 必须继续收满 5 次非 docs-only GitHub timing；YUK-819 在 #1100
  合并且 Linux gate 保持绿色后可 Done，当前不虚报 median 提速百分比。
