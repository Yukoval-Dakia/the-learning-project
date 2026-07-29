# CI 提速研究：先缩短关键路径，不削覆盖

**日期**：2026-07-28
**状态**：并行 gate 与 DB shard 已合入；YUK-820 正在实现 lane 增量 + unit selector shadow
**范围**：`.github/workflows/ci-gate.yml`、`scripts/ci/*` 的 required gate 与 selector

## 结论

当前最值得做的不是再拆测试分类，而是把已经拆好的 `unit`、`db`、`migration`
从一个串行 job 里真正并行起来。

落地分两步：

1. **把主 gate 拆成并行 job**：`static/audits`、`unit`、`db`、`migration`、`build`，
   最后用一个恒定名称的汇总 job 维持 branch protection。
2. 用 GitHub Actions 新结构自然产生的 step/job timing 评估后续优化，不再要求本地跑 CI。

2026-07-29 owner 追加授权 YUK-820：

3. PR gate 先按改动类型选择 lane；unknown/global trigger 仍 fail closed 全量，main push
   永远作为 full canary。
4. unit affected-test selector 先进入 shadow：required unit 仍全量，只对比 selector
   预测与 full JSON 结果，不在本阶段减少 unit 覆盖。

原 Phase 1 不删测试、不做基于路径的测试选择，也不改变 `pnpm test` 的本地 pre-PR
契约；YUK-820 只先做 lane 选择，unit 文件级选择仍为 shadow、required 仍 full。
并行化把远端原来的串行关键路径从近似
`static + unit + db + migration + build` 改成近似这些 lane 的最大值。

## 代码现状

### 1. 主 gate 内部完全串行

`gate` job 依次执行 install、typecheck、lint、三个 standalone audit、`pnpm test`、
`pnpm build`。GitHub Actions 只会在 job 之间并行；同一 job 里的这些 step 不会并行。

而 `pnpm test` 本身又串行执行 11 个 audit、`test:unit`、`test:db`、
`test:migration`。因此：

- 已经独立执行的 `audit:schema` 没有在 `pnpm test` 中重复；
- 但 unit、DB、migration 三个已分区套件仍被一个 shell `&&` 串起来；
- build 只有在全部测试结束后才开始。

### 2. 测试分区基础已经具备

仓库已有三个独立 Vitest config：

- unit：无 global setup；
- DB：单个 Postgres testcontainer，迁移一次，再 clone 为 4 个 fork database；
- migration：自持 testcontainer，单 worker。

也就是说，2026-05-21 的 feedback-loop 方案里“later option 3：CI 并行运行三套件”
已经到了可以实施的阶段，不需要重构测试代码。

当前 cockpit 的最近一次全量证据是：unit 505 files（5779 passed / 33 skipped），
DB 388 files（4201 passed / 9 skipped / 1 todo），migration 26/26。规模上 DB lane
大概率是主关键路径，但没有远端 timing 数据时不应把这个判断冒充测量结论。

### 3. usability 已与主 gate 并行，但重复 install 与 build

`usability` 是独立 job，所以今天已经和 `gate` 并行。它自己再次 install dependencies、
安装/恢复 Chromium、再跑一次完整 `pnpm build`。这是明确的 runner-minute 重复，
却不一定是 wall-clock 的首要瓶颈：若强制等待主 build artifact，反而可能把原本并行的
usability 串到 build 后面。

因此第一刀不应为了“去重”贸然给 usability 加 `needs: build`。先测 build 与
Playwright lane 的时间，再决定是否复用 artifact。

### 4. docs-only 快路径已扩为 lane-level incremental

纯 `docs/**`、`.remember/**`、根目录 Markdown 与嵌套的
`AGENTS/CLAUDE/CONTEXT/README.md` 继续跳过重 gate；`src/subjects/**/SKILL.md`、
judge prompt、test fixture 等运行时/测试 Markdown 不得误判为 docs-only。YUK-820 在此
基础上只先做 lane 选择：unit-test-only 不启 Testcontainers，DB-test-only 不跑
unit/build，UI-only 不跑 DB/migration。schema、migration、kernel/core、
capability manifest、依赖/测试配置、未知路径均全量。

测试文件级选择风险更高，因此不直接 hard switch；先由 Vitest `--changed=<merge-base>`
生成预测清单，再与同一 run 的 full JSON reporter 对账。

## 推荐目标拓扑

```text
changes
  ├─ static-and-audits
  ├─ unit
  ├─ db
  ├─ migration
  ├─ build
  └─ usability                 # 第一轮仍独立构建，保持当前并行度

ci-gate (always())             # 汇总上述 required lanes；名称稳定供 branch protection 使用
```

每个 lane 都继续使用 frozen lockfile、Node 24、pnpm store cache。docs-only 时，lane 可以
直接成功退出；汇总 job 必须 `always()`，并明确拒绝 failed/cancelled 的 required lane，
避免 job 被 skip 后 required check 永久 pending 或误绿。

### 命令分配

| lane | 命令 |
| --- | --- |
| static-and-audits | `pnpm typecheck`、`pnpm lint`、全部现有 audit（各只跑一次） |
| unit | required 仍跑 full unit；另生成 affected selector shadow report |
| db | `pnpm test:db` |
| migration | `pnpm test:migration` |
| build | `pnpm build` |
| usability | 保持当前 build → boot → Playwright 流程 |

不要在远端 split lanes 中继续调用 umbrella `pnpm test`，否则 audit 与测试会重新串行/重复。
`pnpm test` 本身仍保留给本地完整 gate，这是开发者契约，不需要为 CI 拆 job 而改变。

## 测量方案与验收阈值

本环境没有 `gh`、Git remote、GitHub token，也没有可用 Docker，无法可靠读取历史 Actions
timing 或复跑 DB/migration。实施前应在 GitHub 上取得基线，而不是用本机 Node 20 的结果
外推 Node 24 runner。

### 基线

对最近或新触发的至少 10 个非 docs-only PR，记录：

- queue time（与执行时间分开）；
- install、static/audits、unit、DB、migration、build、Playwright 各自耗时；
- `CI Gate` 从 runner start 到 required check 完成的 wall-clock；
- cancelled/retry/flake 次数。

优先使用 Actions job/step timestamps；若要让数据长期可比较，可在 workflow summary 输出
各命令的 elapsed seconds，但不要为了这次优化引入外部 telemetry 服务。

### 成功标准

- **正确性**：新旧命令集合等价；无 audit/test/build 被删；main push 仍跑全量；
- **速度**：非 docs-only PR 的 median required-gate wall-clock 至少下降 25%；
- **稳定性**：10-run canary 内无新增 flake，cancelled run 不被汇总 job 判绿；
- **成本护栏**：runner minutes 可上升（并行会重复 checkout/install），但先限定不超过基线
  中位数的 1.5 倍；若超出，再评估复用依赖或 build artifact。

## 分阶段落地

### Phase 0：只测量

1. 从 Actions UI/API 回填 10-run baseline。
2. 确认 branch protection 当前 required check 的准确名称。
3. 记录 DB lane 是否确实占主导，以及 usability 是否比主 gate 更慢。

### Phase 1：并行主 gate（推荐）

1. 提取一次 docs-only 判定为 `changes` job output，消除现有两份 shell 的漂移；同时采用
   usability 版本的 fail-closed 实现。
2. 拆出五个主 lane；每个 lane 独立 checkout/setup/install/run。
3. 增加稳定名称的 aggregate gate，使用 `always()` 验证所有 required results。
4. 在 feature branch 连跑 10 次（可用空 commit/re-run），再替换 branch protection。

### Phase 2：affected unit selector shadow（YUK-820）

1. `changes` 输出 `unit_selection=skip|affected|full` 与 merge base。
2. `affected` 时运行 `vitest list --changed=<merge-base> --filesOnly --staticParse`，
   再并入不依赖 import graph 的源码扫描 sentinel tests。
3. full unit 使用 default + JSON 双 reporter，测试只执行一次。
4. 对账只观察：
   - full 失败但 selector 未选中的 test file；
   - 直接改动但 selector 未选中的 unit test；
   - selector failure 是否安全 fallback 到 full。
5. compact JSON 作为 Actions artifact，摘要写入 step summary。Shadow miss 先 warning，
   required full unit 的原始 exit code仍决定 gate。
6. 至少 20 个混合 PR 零漏选后，另行决定是否把 affected set 升为 required；本阶段不切。

Shadow 的限制必须明确：一次全绿只能证明“本次 full 没发现 selector 漏掉的失败”，不能证明
import graph 完备。因此 main push 保留 full canary，动态 import、manifest、源码扫描、
migration/raw SQL 继续由显式 full trigger / sentinel 保护。

### 后续：按数据选做

- **若 build 明显拖慢 usability**：由 build lane 上传 `dist/**` 与 `web/dist/**`，验证 artifact
  完整性后再比较“等待共享 artifact”与“独立并行 build”的 wall-clock；只在前者更快时切换。
- **若 install 成为总成本热点**：先看 pnpm cache hit；不要缓存 `node_modules`，除非证明
  runner/ABI/key 能安全复用且收益稳定。
- **若 DB 仍是绝对关键路径**：用 Vitest slow-test 报告找 file-level 长尾，再决定是否调高
  `DB_FORK_COUNT`。不能只凭 2-core runner 假设盲目从 4 增大。

## 明确不做

- 不删 DB/migration/usability 覆盖来换速度；
- 不在 shadow 证据通过前把 affected unit set 升为 required；
- 不把 production dependency audit 改为非阻塞；
- 不在没有 timing 的情况下调整 DB fork 数；
- 不用自托管 runner 或新 SaaS 解决一个尚未量化的问题。

## 预期风险

| 风险 | 约束 |
| --- | --- |
| aggregate job 在上游 cancelled 时误绿 | `if: always()` + 显式允许值仅为 `success`（docs-only 也让 lane 自己 success） |
| required-check 改名导致 PR pending | 先保留/复用稳定汇总名称，再切 branch protection |
| 并行提高 runner minutes | 以 1.5× 成本护栏衡量，速度和成本分开决策 |
| 多 job 重复 install | 接受为第一轮可逆代价；用 cache-hit/timing 决定是否继续优化 |
| docs-only filter 漂移 | 单一 `changes` output，失败时保守 `code_changed=true` |

## 决策建议

**并行 Phase 1 已落到 `.github/workflows/ci-gate.yml`**。YUK-820 在不改变 required
check 名称的前提下加入 fail-closed lane planner；main push、unknown path/base 与全局
trigger 仍全量。Phase 2 只启用 unit selector shadow，required unit 继续 full，等 20 个
混合 PR 的报告再决定是否硬切。
