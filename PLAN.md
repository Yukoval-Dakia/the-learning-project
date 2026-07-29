# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-07-29
> **【更新 2026-07-29 · YUK-814 harness 收口中，真实执行仍等 owner 数据】**
> backup→一次性 DB→生产 evidence chain→shadow/blind→score/canary harness 已构建；
> PR #1105 已修完 P1/major review，正在吸收最新 main。真实 shadow/blind/canary 尚未
> 执行；唯一产品事实阻塞仍是 6–10 个真实 owner 失败簇，不以 synthetic/mock 冒充。

## NOW

- **唯一 active 线：YUK-814 离线真实数据闸门 harness（PR #1105）**
  - Branch：`codex/yuk-814-grounding-gate`；worktree：
    `/Users/yuqi/yukoval-projects/the-learning-project-worktrees/yuk-814-grounding-gate`。
  - `pnpm grounding:gate` 已提供 inspect、shadow、score-blind、init-canary、
    score-canary；backup 只恢复进自动清理的一次性 pgvector Testcontainer。
  - 资格链复用生产 correction/history/accountability/evidence-enrichment/image gates，
    额外排除 `payload.__synthetic=true` 与 `synthetic:*`；shadow 不写产品 proposal/event。
  - deterministic selection 已锁 requested count + selection SHA-256；provider global
    overrides 与 dirty worktree 均 fail closed；blind/private lineage 分离。
  - blind gate 要求 6–10 簇、grounding ≥80%、三项红线为 0；canary 必须同一
    owner/cohort、10 个 distinct intervention、监控 refs 与停机演练齐备。
  - synthetic smoke 只证明 harness：12 failures → 6 eligible、`gate_passed=false`；
    不构成 YUK-814 真实 gate 证据。
- **近期已收口**
  - YUK-820 已随 PR #1103 / `7dd15a8e` 落到 main：affected unit required、
    direct-test guard 与 fail-closed fallback 已有 20 个历史 PR backfill 证据；
    PR head full Gate `30431860540` 与 main full canary `30432387630` 均全绿，
    main artifact 的 requested/effective/required 均为 `full`。
  - YUK-788 已随 PR #1102 / `ff681b0c` 合并并 Done；identity history gate、terminal
    reopen 约束与 owner feedback 回流均有回归证据。
  - YUK-803 的 soft archive/hard 不变已在 PR #1080 / `a1fe8ab8` 落地，
    `conjecture-accept.db.test.ts` 21/21，Linear Done。
  - YUK-817/818/819 已 Done；DB shard、unit 长尾与 JYEOO hard timeout 修复在 main。

## NEXT

1. 完成 PR #1105 与最新 main 的冲突收口；当前 head 的 CI Gate 全绿且 active review
   threads 为 0 后合并。合并只代表 harness ready，YUK-814 不提前 Done。
2. 从 production `/api/_/export?include_assets=1` 获取真实 backup，先跑 inspect；
   eligibility 不足 6 就继续积累真实使用，不制造错误。
3. eligibility 满足后 shadow → owner blind review → score；grounding ≥80%，学科幻觉、
   claim/probe 错配、严重事实错误均为 0，任一红线失败即停。
4. 只有 blind PASS 后才依次启动 intervention snapshot、pedagogy、
   QuestionAuthor/Verify、隔离 FSRS、结算、Brief/Copilot/profile 与 10-run canary。

## PARKED

- **CI selector drift**：main full canary 或 direct-test guard 任一发现漏选，立即回退
  full required；不靠漂亮 selection ratio 压掉证据。
- **CI 后续调参**：usability artifact 复用、DB weighted shard / fork 数继续以
  GitHub timing 决定，不用删覆盖换漂亮指标。
- **干预准备**：YUK-791/796；Planning Panel 仅为 Teaching Brief 控制区。
- **验证结算**：YUK-792；猜想与干预使用隔离 FSRS 状态，普通 KC/FSRS 不变。
- **协作与档案**：YUK-815 Brief/Copilot public reader；YUK-816 intervention history。
- **发布**：YUK-814 通过后才做单 owner/cohort 10-run canary；任一红线失败关闭
  auto-intervention flag。

## BLOCKED-ON

- **YUK-814 真实执行** ← production backup ZIP / 6–10 个合格真实 owner 失败簇；
  harness、anthropic-sub 与本机工具链已就绪。
- **干预实现** ← YUK-814 grounding blind review 通过；不得先写产品状态机绕过门。
- **auto-intervention 扩大** ← 单 owner/cohort 10 次 canary 全部事后审阅，红线为 0。
