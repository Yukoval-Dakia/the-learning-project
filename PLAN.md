# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-07-29
> **【更新 2026-07-29 · 猜想证据收口，串行到达真实 owner 数据闸门】**
> YUK-788 已随 PR #1102 合并，YUK-803 已按现有代码/DB 测试证据化关闭；
> 两项目联合计划现已严格串行到 YUK-814。模型运行环境 pre-flight 通过，当前唯一
> 事实阻塞是缺少可供盲评的 6–10 个真实 owner 失败簇；不以 synthetic/mock 冒充。

## NOW

- **当前无代码 active lane；YUK-814 保持 Backlog，等待真实数据输入**
  - Node、pnpm、Docker daemon、Claude Agent SDK、`DATABASE_URL` 与
    anthropic-sub OAuth token 均已做不泄密 pre-flight；凭据不是 blocker。
  - 仓内不存在 YUK-814 专属盲评数据集/评分 artifact；配置 DB 指向本地
    `127.0.0.1:5433`，且没有既有 compose volume。试启时只创建了全新空库，已立即
    删除容器、network 与 volume，未留下假数据或运行中服务。
  - 因此本轮不启动 shadow、blind review 或 canary；继续只能造 mock，违反发布闸门。
- **YUK-788 已收口**
  - PR #1102 merge commit：`ff681b0c`；Linear Done。
  - pending、30 天 dismiss cooldown、active accepted 与 terminal reopen 共用
    identity history gate；terminal 后仅同 cause×KC 的两条更新 failure 可重开。
  - owner accept/edit claim 已回流 deterministic 与 agent-led shadow lane；correction、
    rollback、旧 proposal terminal、新 proposal active 等反例均有回归。
  - exact head `83b857b0` 的 CI Gate 全绿、已产出 review thread 清零。按 owner 规则，
    review 收敛到 P2/minor 后不等待下一轮 OCR，直接听全绿 gate 合并。
- **YUK-803 已证据化收口**
  - 选项 (a) 已在 PR #1080 / merge commit `a1fe8ab8` 落到 main：edit 归档同
    cause×KC 的 soft misconception 与 live edges，hard 节点不动，plain accept 不变。
  - `conjecture-accept.db.test.ts` 本轮实跑 21/21；Linear 已由 Backlog 对齐 Done。
- **CI 提速后续保持独立**
  - main 已有 parallel static/unit/DB/migration/build/usability lanes 与 fail-closed
    aggregate；YUK-817/818 继续收满 5 次非 docs-only timing，不在 Grounding 线扩张。

## NEXT

1. 为 YUK-814 提供/导出 6–10 个真实 owner 失败簇，保留题面、作答、Judge/错因、
   subject/KC 与可复现 evidence refs；禁止 synthetic/mock 代替。
2. 数据到位后才把 YUK-814 置 In Progress：先 shadow run，再 owner gold blind review；
   grounding ≥80%，学科幻觉、claim/probe 错配、严重事实错误均为 0。
3. 只有 YUK-814 通过，才依次启动 intervention snapshot、pedagogy、
   QuestionAuthor/Verify、隔离 FSRS、结算、Brief/Copilot/profile。

## PARKED

- **CI 后续调参**：只在 5 次非 docs-only GitHub timing 证明仍有必要时评估
  usability artifact 复用、DB 4-way shard 或 fork 数；不做 path-aware 测试跳过。
- **干预准备**：YUK-791/796；Planning Panel 仅为 Teaching Brief 控制区。
- **验证结算**：YUK-792；猜想与干预使用隔离 FSRS 状态，普通 KC/FSRS 不变。
- **协作与档案**：YUK-815 Brief/Copilot public reader；YUK-816 intervention history。
- **发布**：YUK-814 通过后才做单 owner/cohort 10-run canary；任一红线失败关闭
  auto-intervention flag。

## BLOCKED-ON

- **YUK-814 shadow/blind gate** ← 6–10 个真实 owner 失败簇的数据来源/导出；
  anthropic-sub 与本机工具链 pre-flight 已通过。
- **干预实现** ← YUK-814 grounding blind review 通过；不得先写产品状态机绕过门。
- **auto-intervention 扩大** ← 单 owner/cohort 10 次 canary 全部事后审阅，红线为 0。
