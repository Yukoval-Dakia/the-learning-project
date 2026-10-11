# YUK-1404 — 整合交付报告：math-merge-presentation × merge-admission-confirmation

日期：2026-10-11 · 分支：`fix/yuk-1404-math-merge-presentation`
工作树：`/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1404-math-merge-presentation`
整合 head：见下方 git 记录（normal merge commit，无 cherry-pick/rebase）。

## 1. 整合方式与来源

- **Lane A（本树既有）**：`01320126304a2da821b180bfb2f863b351b5bace`
  （`fix/yuk-1404-math-merge-presentation`，自 main `81efd7da2`，3 commits：
  `57e5625a7` O1–O3 基础 → `59681418b` R1 修复 → `013201263` R2 修复）。
- **Lane B（只读来源）**：`/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1404-merge-admission-confirmation`
  的 `be7ec19d64eb7b9dfa2267f04d3081f694e9a961`（含其父 `e1c5a216e`，
  同一 base `81efd7da2`）— confirm_lossy 合同 + 确定性 AI 提议准入。
- **整合**：`git merge be7ec19d`（ort 策略，`--no-ff` 等价正常 merge），
  零冲突；`src/ui/lib/api-schema.generated.ts` 自动合并。
- **main 普查**：fetch 后 `origin/main` 领先 12 commits（dependabot  deps、
  ADR-0068/0069/0070、YUK-1405/1359/1438）；#1657/#1658 未合入 main，未带入。
  `git merge-tree --write-tree HEAD origin/main`（merge 前后各一次）均无冲突
  → 按「only if needed」**未做 main merge**，无 moving-migration 整合。
- 未含 UI / Start / boot / DBOS / DB / 容器 / runtime / provider / key /
  付费调用 / deploy；未 push 前无外部副作用；无子委托。

## 2. Whole-patch subset proof（对 base `81efd7da2`）

合并后整树相对 base 的 diff = 两个已审 lane diff 的并集 + 一个可确定性再生的
文件：

- **Lane A 全部 9 个文件** `git diff 013201263..HEAD -- <files>` = **0 行**
  （与已审 R2 修复 head 逐字节一致）。
- **Lane B 全部 17 个文件** `git diff be7ec19d..HEAD -- <files>` = **0 行**
  （与已审 R2-repaired head `be7ec19d` 逐字节一致）。
- **唯一双侧触碰文件** `src/ui/lib/api-schema.generated.ts`：ort 自动合并，
  `pnpm gen:api-client` 再生成 **零 diff**（合并结果 = 合并后契约的确定性
  codegen 产物）。
- 已审 revision/range：A 侧 `57e5625a7..013201263`（R1 raw-truncate → R2
  renderer-parser 修复，R2 发现由 parent 探针复现、修复后 parent 复核）；
  B 侧 `e1c5a216e..be7ec19d`（R1 缺陷修复，final R2 GLM **NONE**）。

## 3. 探针与证据（全部走真实生产函数）

均在合并后 head 上、offline env（`sh /tmp/yuk1359-offline-env.sh`）执行：

| 探针 | 结果 |
|------|------|
| parent 探针 `/tmp/yuk1404-r2-parent-math-probe-20261010.ts` | 4 例输出与已存 `probe-after-fix.log` **逐字节一致**（excerpt 在数学 span 开界前回退，无 `$`/定界符泄漏；`cuts_math:true` 是源文本 AST 属性，非截断缺陷） |
| `preserved-invariants.ts`（82 断言 A/B/C/D） | **ALL PASSED** |
| `grammar-repair-evidence.ts`（4 R2 形 + raw48 + legacy 偏移） | **ALL PASSED** |
| 旧 `evidence.ts` | 仅 line 566 一处失败 = **已记录假前提**（`$a$$b^2$` 实为单个 inlineMath；该断言已在 preserved-invariants.ts:570 按实际语法改写并通过）——非回归，文档化 supersede |
| scoped unit：`pnpm vitest run --config vitest.unit.config.ts src/kernel/proposals/block-merge-admission.unit.test.ts` | **28/28 PASS** |

## 4. Source gates（合并后源码逐点核对）

- `confirm_lossy`：`z.literal(true).optional()`（`src/core/schema/proposal.ts:130`）
  — 仅字面 `true`；accept-only 且 kind-scoped，在共享 dispatch 边界拒绝
  非 accept/非声明 kind（`accept-action.ts:50-61`）。
- 409 `confirm_required`：在 `mergeQuestions` 调用**之前**抛出（preflight 与
  locked recheck 共用 `assertBlockMergeAdmission`；`proposal-appliers.ts:124-130`），
  载荷含 `affected_block_count`、message「合并后无法撤销」；写零发生。
- payload 顺序 STRICT+1：链 = `[primary, ...effectiveMergeIds]`（去重+剥主块，
  保 caller 序），逐对 `min === prev.max+1`，否则 `pages_not_adjacent`
  （`block-merge-admission.ts:345-350`）。
- source_document：链内唯一 `source_document_id` 且须解析到真实行
  （`block-merge-admission.ts:326`）。
- 未知题号 fail closed：`lead.kind === 'unknown'` → `missing_continuity`
  （`block-merge-admission.ts:363`）；无 rescue helper。
- **无 confidence cutoff**：模型 confidence/reason/signal 不参与准入
  （`block-merge-admission.ts:32-33` 注释声明 + 代码无该字段读取）。
- pending 内部保留不删：inbox 过滤是读规则，行保持 stored（`inbox.ts:92,
  394-397`）；cooldown dedup 看 RAW pending 集（`inbox.ts:1112`）。
- accepted 历史/replay：`existingAcceptRate` 幂等路径先于 admission
  （`proposal-appliers.ts:101-110`）；inbox 只过滤 `pending`。
- locked recheck：`admission` hook 在 `mergeQuestions` 自 tx 内、
  FOR UPDATE 锁之后、任何写之前执行，throw 全回滚
  （`proposal-appliers.ts:140-144`、`block-structured-edit.ts:540-544`）。
- learner-directed exempt：`admission?` 为可选参数，merge_questions
  DomainTool（非提议路径）不传（`block-structured-edit.ts` 参数注释）。

## 5. 本地门

`pnpm typecheck` ✅ · `pnpm lint` ✅（0 error，174 条存量 warning，
改动文件 0 条）· `pnpm build` ✅（web + server/worker/migrate esbuild 全部
产出；migrate 5.7mb 无 parser 与 596 基线一致）· `pnpm gen:api-client` ✅
零 diff · `pnpm gen:postman` ✅ 零 diff（33 folders/87 paths/94 requests）。
未跑 full `pnpm test`（规约）；未新增测试。

## 6. 留给 parent 的 scoped DB 命令（本 lane 未运行）

```bash
cd /Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1404-math-merge-presentation && \
  pnpm vitest run --config vitest.db.config.ts \
  src/capabilities/ingestion/server/proposal-appliers.db.test.ts
```

（该文件 +295 行覆盖 confirm_lossy accept 生命周期/幂等/cooldown；
对应 B 侧已声明 DB UNRUN 义务。）

## 7. 未决 gate / 边界

- DB 车道测试未在本机运行（policy + 任务约束），由 parent / exact-head
  CI Gate 执行。
- 裸公式产出质量未经付费 sealed gold 验收（继承 lane A O1 声明）。
- review 预算：本 PR 为整合交付，actual diff 的初始独立审由 parent 裁定/
  委托；§2 subset proof 已记录于 PR 供免审裁决参考。
- 无 merge、无 deploy、无 Linear 状态改动。
