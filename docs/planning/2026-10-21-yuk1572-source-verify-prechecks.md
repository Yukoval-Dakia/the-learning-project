# YUK-1572 — source_verify 结构/来源一致性纯预检下沉

- lane: `src/capabilities/practice/jobs/source_verify.ts` fixed `ce74a7733f93044f55c0b00d056ae3c8d137f1fc`:342–453（structure_completeness + source_consistency 纯预检完整闭包）。
- branch: `arch/yuk-1572-source-verify-precheck`（自 `origin/main` ce74a7733 切出，不带父旧提交）。
- worktree: `/Users/yuqi/.t3/worktrees/the-learning-project/t3-676c8352`

## 变更

| 文件 | 动作 | 物理行数 |
|---|---|---|
| `src/capabilities/practice/jobs/source_verify.ts` | modify | 1723 → 1613（−110 净） |
| `src/capabilities/practice/jobs/source_verify_prechecks.ts` | create | 171 |

迁出闭包（逐字，签名两处除外）：`CheckOutcome`、`SOURCE_GROUNDING_MIN_OVERLAP`、`checkStructureCompleteness`、`checkSourceConsistency` 及各自 docblock。签名变化仅 `function`→`export function`、参数 `QuestionRow`→`SourceVerifyPrecheckInput`（新窄输入记录，恰为两检查实际读取的 7 个列字段，类型与列定义一致；`QuestionRow` 结构兼容，两处调用点原文不变）。旧文件以 `export type { CheckOutcome }` + `export { SOURCE_GROUNDING_MIN_OVERLAP } from ...` 保既有 import 路径（同 `DEDUP_OVERLAP_THRESHOLD` 先例）；`runSourceVerify` / `publishVerifyLifecycleUpdate` / `buildSourceVerifyHandler` / `checkDedup` / `solveCheckToOutcome` 与全部 paid/claim-fence/frozen-revision/typed-publish 路径逐字节不变（hunk 止于 base:453，见证据 `diff-protected-blobs.txt`）。

## 拆分边界为何成立

预检簇是 tier-2 检查集里唯二「只读行内容即可判定」的成员：dedup 要查池（DB）、solve_check 要花 LLM，留在 handler。边界按「能否纯」切——移出的是完整知识簇（判定 + 阈值 + 判定记录形），非按行数切块。新模块零 DB/网络/LLM 依赖（含 type 级不引 schema），`SourceVerifyPrecheckInput` 使「哪些字段喂哪条规则」的知识留在模块内。1613 > 1500：本 lane 授权只放 342–453（约 112 行），run564+ 的 frozen-revision 投影/claim-fence/终态事务仍属同簇大头来迁出部分，如实报告未达阈值，不为数字动保护段。

## 两个真实变化场景

1. **来源结构/一致性规则变化**（调阈值、改必填字段、改 provenance 解释）：改 `source_verify_prechecks.ts` 一处；caller（`runSourceVerify`）此前要知道检查读 `QuestionRow` 的哪些列，现在只需传 verify-input，字段契约由模块自证。
2. **claim/frozen 发布恢复变化**：落在 `publishVerifyLifecycleUpdate` / `runSourceVerify` 锁序与 paid-effect 段——本批逐字节未动，仍由旧文件承载。

## 机器验证

- 实跑：`git diff` protected blob 逐段 sha256 对账（见 artifact `diff-protected-blobs.txt`）；迁出函数体/常量/docblock 与 base `diff` IDENTICAL；import 块全 diff 恰为 4 处登记改动。
- NOT_RUN：`pnpm typecheck` / `lint` / `build` / 两 audit——本 worktree 无 `node_modules`（T3 新建未装；全局 biome 2.5.7 / tsc 7.0.2 与仓库 pin ^2.5.8 / TS6 不采信），按规约不自行 install/复制，交父安排一次 frozen install 后补跑。新文件 import 边是 `jobs/` 同目录既有边的真子集（无新增 capability→server 债）；audit:capability-boundaries / audit:architecture-deepening 若因新文件条目需 baseline 登记，实测结果交父，不自行改 baseline。

证据：`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1572/<head>/source_verify/`
