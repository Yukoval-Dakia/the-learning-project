# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-07-29
> **【更新 2026-07-29 · YUK-788 owner 决策回流 review 缺口已修，重跑远端验收】**
> YUK-795 已随 PR #1101 合入 main；当前已把 pending、dismiss cooldown、active accept
> 与 terminal reopen 统一接入 nightly identity gate，并让重开的归纳读取 owner 最近一次
> accept/edit claim。定向 unit/DB 与 typecheck 已通过；首轮远端全绿后发现的 review
> 缺口均已补回归，当前等待新 head 的 Actions/OCR。

## NOW

- **唯一 active 线：Grounding · 猜想证据 YUK-788**
  - Branch：`codex/yuk-788-owner-feedback-loop`；PR #1102。
  - Worktree：
    `/Users/yuqi/yukoval-projects/the-learning-project-worktrees/yuk-788-owner-feedback-loop`。
  - pending proposal 仍由 inbox projection 第一层去重；owner decision / probe terminal
    history 在同 capability 内作为第二层 gate。
  - dismiss 同 cell 冷却 30 天；accepted 但未 terminal 的 active conjecture 不重复归纳。
  - confirmed/retired terminal 后必须出现至少两条更晚的有效 failure attempt 才能 reopen；
    enrichment 后会用可复现 evidence 再验一次 fresh floor；重开时把最近 accept/edit 的
    owner claim 注入 `prior_claim_md`，无 claim fail closed。
  - lifecycle fold 按每个 proposal 的最新 rate 取 identity 最新决定；rollback 会撤销旧
    accept，terminal 只结算到 identity 当前最新 accepted proposal，不能由旧 proposal
    的更晚 terminal 错放仍在测试中的新 proposal。
  - 默认关闭的 agent-led shadow lane 复用同一 history gate：agenda 先滤 active /
    cooldown / terminal fresh floor，write guard 再读一次；terminal reopen 必须原样回传
    agenda/软拒绝给出的 owner `prior_claim_md`，不能绕过 deterministic lane。
  - terminal 读取复用 correction-aware probe evidence reader；proposal/rate/result 查询按
    candidate KC 限域并分块，不新建事件流。
  - 定向 unit 79/79（nightly 44 + director tools 35）、定向 DB 36/36
    （closed-loop 18 + director 18）、typecheck、Biome、diff check 已通过；
    review 指出的 stale accept、corrected rate、enrichment 后 fresh floor 三条缺口均已
    补回归；latest accepted proposal/rollback fold 反例也已覆盖，history filter 的 map
    side effect 已移除。
- **CI 提速已并入**
  - main 已拆 static/audits、unit、DB、migration、build、usability 并行 lanes；
    DB reset 合批并拆为两路 shard，末端 aggregate 保留 required-check 名称并
    fail closed。
  - #1100 首次样本 DB shard 为 6m15s / 5m11s；5 次 median 验收仍由
    YUK-817/818 继续收数，不在本产品线扩张。
  - 按 owner 指示，不在本地重复跑 CI gate；只监听 GitHub Actions。
- **YUK-787 / YUK-795 已收口**
  - PR #1098 / #1101 已合并；CI Gate、OCR 与 CodeQL 全绿，Linear 均 Done。
  - 当前分支基于 `origin/main@41fa2a07`。

## NEXT

1. 监听 PR #1102 最新 head 的 GitHub Actions/OCR；处理阻塞项后合并并对齐 Done。
2. 证据化收口已在 YUK-785 落地但 Linear 仍 Backlog 的 YUK-803：edit archive soft、
   hard 不变；只在代码/测试与 issue 验收逐项一致后关闭。
3. 通过真实 owner 数据闸门 YUK-814 后，才进入 intervention snapshot、pedagogy、
   QuestionAuthor/Verify、隔离 FSRS、结算、Brief/Copilot/profile。

## PARKED

- **CI 后续调参**：只在 5 次非 docs-only GitHub timing 证明仍有必要时评估
  usability artifact 复用、DB 4-way shard 或 fork 数；不做 path-aware 测试跳过。
- **干预准备**：YUK-791/796；Planning Panel 仅为 Teaching Brief 控制区。
- **验证结算**：YUK-792；猜想与干预使用隔离 FSRS 状态，普通 KC/FSRS 不变。
- **协作与档案**：YUK-815 Brief/Copilot public reader；YUK-816 intervention history。
- **发布**：owner shadow/blind review；单 cohort 10-run canary；任一红线失败关闭
  auto-intervention flag。

## BLOCKED-ON

- **干预实现** ← 猜想/probe/Judge 的 v2 证据状态机与 owner 数据门通过。
- **真实数据扩大使用** ← 6–10 失败簇盲评：grounding ≥80%，学科幻觉、
  claim/probe 错配、严重事实错误均为 0。
- **auto-intervention 扩大** ← 单 owner/cohort 10 次 canary 全部事后审阅，红线为 0。
- **真实模型验收** ← owner 数据与 anthropic-sub 运行凭据；不得用 mock 代替。
