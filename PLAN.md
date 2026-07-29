# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-07-29
> **【更新 2026-07-29 · YUK-814 离线闸门 harness 已构建，真实执行仍等数据】**
> 严格串行已进入 YUK-814；只读 backup→一次性 DB→生产 evidence chain→shadow/blind
> →score/canary harness 已完成本地全量 gate。真实 shadow/blind/canary 尚未执行；
> 当前唯一事实阻塞仍是 6–10 个真实 owner 失败簇，不以 synthetic/mock 冒充。

## NOW

- **唯一 active 线：YUK-814 离线真实数据闸门 harness**
  - Branch：`codex/yuk-814-grounding-gate`；worktree：
    `/Users/yuqi/yukoval-projects/the-learning-project-worktrees/yuk-814-grounding-gate`。
  - `pnpm grounding:gate` 已提供 inspect、shadow、score-blind、init-canary、
    score-canary；backup 只恢复进自动清理的一次性 pgvector Testcontainer。
  - 资格链复用生产 correction/history/accountability/evidence-enrichment/image gates，
    额外排除 `payload.__synthetic=true` 与 `synthetic:*`；shadow 不写产品 proposal/event。
  - blind packet 与 private lineage 分离；6–10 簇、grounding ≥80%、三项红线为 0；
    canary 必须同一 owner/cohort、10 个 distinct intervention、监控 refs 与停机演练齐备。
  - synthetic smoke 仅验证 harness：12 failures → 6 eligible；`gate_passed=false`。
    本地 pre-PR 全量：unit 5,824、DB 4,263、migration 26，typecheck/lint/audits/build 全绿。
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

1. 提交 YUK-814 harness PR，处理独立 review；CI Gate 全绿后合并，但 issue 不提前 Done。
2. 从生产 backup endpoint 导出真实 owner 数据；有图片的簇必须 `include_assets=1`。
3. 运行 inspect；至少 6 个 fully reproducible/image-ready cluster 后执行 shadow 与 owner
   gold blind review。grounding ≥80%，学科幻觉、claim/probe 错配、严重事实错误均为 0。
4. 只有 blind gate 通过，才依次启动 intervention snapshot、pedagogy、
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

- **YUK-814 真实执行** ← 生产 backup ZIP / 6–10 个合格真实 owner 失败簇；
  harness、anthropic-sub 与本机工具链已就绪。
- **干预实现** ← YUK-814 grounding blind review 通过；不得先写产品状态机绕过门。
- **auto-intervention 扩大** ← 单 owner/cohort 10 次 canary 全部事后审阅，红线为 0。
