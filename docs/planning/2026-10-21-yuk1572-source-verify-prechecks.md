# YUK-1572 — source_verify 结构/来源一致性纯预检下沉

- lane: `src/capabilities/practice/jobs/source_verify.ts` fixed `ce74a7733f93044f55c0b00d056ae3c8d137f1fc`:342–453（structure_completeness + source_consistency 纯预检完整闭包）。
- branch: `arch/yuk-1572-source-verify-precheck`（自 `origin/main` ce74a7733 切出，不带父旧提交）。
- worktree: `/Users/yuqi/.t3/worktrees/the-learning-project/t3-676c8352`

## 变更

| 文件 | 动作 | 物理行数 |
|---|---|---|
| `src/capabilities/practice/jobs/source_verify.ts` | modify | 1723 → 1606（−117 净） |
| `src/capabilities/practice/jobs/source_verify_prechecks.ts` | create | 172 |

迁出闭包（逐字，签名两处除外）：`CheckOutcome`、`checkStructureCompleteness`、`checkSourceConsistency` 及 `SOURCE_GROUNDING_MIN_OVERLAP` 与各自 docblock。签名变化仅 `function`→`export function`、参数 `QuestionRow`→`SourceVerifyPrecheckInput`。`runSourceVerify` / `publishVerifyLifecycleUpdate` / `buildSourceVerifyHandler` / `checkDedup` / `solveCheckToOutcome` 与全部 paid/claim-fence/frozen-revision/typed-publish 路径逐字节不变（hunk 止于 base:453）。

**公开出口（全通道消费核验后收敛）**：`CheckOutcome` 保留在新模块（`source_verify.ts` 是真实 type consumer——type-import 供 dedup/solve/result 使用）；`SOURCE_GROUNDING_MIN_OVERLAP` 经 namespace/`export *`/`require`/`vi.mock`/dynamic `import()`/字符串引用全通道核验零外部消费者（`verify-and-promote` 只取 `publishVerifyLifecycleUpdate`/`runSourceVerify`，manifest 动态 import 只取 `buildSourceVerifyHandler`，test 只取 `runSourceVerify`），不再导出——模块内私有 const，旧文件无 re-export、无 compat。

## 拆分边界为何成立

预检簇是 tier-2 检查集里唯二「只读行内容即可判定」的成员：dedup 要查池（DB）、solve_check 要花 LLM，留在 handler。边界按「能否纯」切——移出的是完整知识簇（判定 + 阈值 + 判定记录形），非按行数切块。新模块不发起 DB/网络/LLM 调用，也不 import question 表的 Drizzle 类型；它并非零依赖——仍 value-import 原有规则助手（`@/core/schema/provenance`、`normalizeToCanonicalKind`、`maxNgramOverlap`）并 type-import `VerifyCheck`。1606 > 1500：本 lane 授权只放 342–453（约 112 行），run564+ 的 frozen-revision 投影/claim-fence/终态事务仍属同簇大头来迁出部分，如实报告未达阈值，不为数字动保护段。

## 两个真实变化场景

1. **来源结构/一致性规则变化**（调阈值、改必填字段、改 provenance 解释）：改 `source_verify_prechecks.ts`。规则编辑面迁移前后本都单文件（原在 handler 内、现在独立模块），不声称新增单点收益；真实新增是规则体与事务/paid 编排分离成纯模块，且 `SourceVerifyPrecheckInput` 以窄 structural 输入脱离 Drizzle row type。
2. **claim/frozen 发布恢复变化**：落在 `publishVerifyLifecycleUpdate` / `runSourceVerify` 锁序与 paid-effect 段——本批逐字节未动，仍由旧文件承载。

## 机器验证

- 实施轮（head `3982c824a`）静态证据：`…/architecture-deepening/YUK-1572/3982c824ad81f3f5288bf6a24ad816d97923f5e1/source_verify/`（protected blob 逐段 IDENTICAL、迁出体逐字、import 全 diff 恰为登记改动）。
- 收尾轮（本 doc 所在 commit）：父完成 frozen install 后经 heavy.sh 串行实跑 typecheck/lint/build/audit:capability-boundaries/audit:architecture-deepening，原始日志+argv+UTC+真实 rc 封于 `…/architecture-deepening/YUK-1572/<本 commit head>/source_verify/`，不覆盖首轮 seal。audit 如需实测来源记录/size-decrease 登记，结果报父，baseline 不动。
