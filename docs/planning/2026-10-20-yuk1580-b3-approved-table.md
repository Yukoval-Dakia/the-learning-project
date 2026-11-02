# YUK-1580 B3 批准实施记录：blank 冲突旗标四 case → 一条四行表驱动

日期：2026-10-20。范围：**仅 B3**。B1 与其他测试、产品代码、fixtures、配置、audit、CI 一律未动。

## 批准与协调

- Owner 2026-10-20 20:01 JST 状态页经协调**只批准 B3**。
- 批准文本：四 case 合成四行表驱动；四种输入、每行独立 `request_id`、`rejected` 断言、各自 casefold/trim 错误片段**全保留**。
- 主线协调确认：`src/server/questions/edit-submit.db.test.ts` 在 main 无在途 diff、无未公开 writer；本次批准**不附带 DB 运行授权**。
- 方案原文（已实际读取并核对）：
  - 路径 `/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1580/26d80160fd3bf0f231f9c3f941f5369520d5ff6a/parent-selection-brief.md`
  - SHA-256 `0d58819b62a3aeffcc5782c6e3d0d81df237ad381202431765fc300764861560`
  - 关键原文：『**B3，建议优先批准**：`src/server/questions/edit-submit.db.test.ts` 的 L1868、2367、2391、2415，四个冲突旗标 case 改为一条四行表驱动。必须保留四种输入、独立 request_id、rejected 断言及各自 casefold/trim 错误片段；不得只保留统一"拒绝"断言。预计省约 55 行，实际以 diff 为准。』

## 实施

- 分支 `arch/blank-flag-table`，基点 `origin/main` = `4fd179818bd4a3ad8f16c07b2c9f38daa1adc259`（fetch 后核对：本地 HEAD 落后 3 个提交，已从最新 origin/main 切出）。
- 四个独立 `it(...)` case 合并为一条 `it.each` 四行表驱动，位于原第一个 case 位置；`$title` 插值保留四个原测试名，每行仍是一次独立 vitest case 运行（非共享 for 循环，首行失败不跳过后续行）。
- 四条 `@invariant grading` / `@fails-if` 注释对逐字保留在合并 case 前，test-policy 准入以 `grading` 类别计。
- 行对象 `key` 字段用 `satisfies ... key: DraftBlankTextKeyT` 声明，新增一条 type-only import。
- 保留要素（每行）：prompt、完整 key 字面量（`kind:'text'`、`accepted:['H2O']`、旗标字段、`{ ...BLANK_NORM, <归一化旗标> }` spread）、独立 `request_id`、`saveDraftEdit` + `ACTOR` 真实入口、`testDb()`、`blankDocument`、blank fixture guard、`expect(saved.status, JSON.stringify(saved)).toBe('rejected')` + `saved.issues` 的 `JSON.stringify(...).toContain(<该行错误片段>)`。

## 行数

- 改前（origin/main）：2698 行；四块位于 L1866-1888、L2365-2387、L2389-2411、L2413-2435（`it(...)` 声明行 1868/2367/2391/2415，与方案所列一致）。
- 改后：2686 行；合并块位于 L1870-1948（注释 L1870-1877，`it.each` L1878-1948）。
- `git diff --stat`：+71 / −83，净 **−12 行**。方案预估 ~55 行为估算值，实际以本 diff 为准：保留每行完整 key 字面量（含 BLANK_NORM spread）占去了大部分行数，消重的是四份重复 setup/assert 体（4×15 行 → 1×15 行 + 4 行数据声明）。

## 四行 ↔ 原 case 等价映射

| 表行 | 原 case（origin/main 行号 / 测试名） | prompt | 旗标输入 | request_id | 错误片段断言 |
|------|----------------------------------|--------|----------|------------|--------------|
| 1 | L1868 `rejects a blank key that is both case sensitive and casefolded` | `大小写冲突：水的化学式是` | `case_sensitive:true` + `normalization.casefold:true` | `casefold-conflict-save` | `'casefold'` |
| 2 | L2367 `rejects a blank key that asks to ignore case and also keep case` | `大小写双关：水的化学式是` | `case_sensitive:false` + `normalization.casefold:false` | `casefold-false-conflict-save` | `'casefold false'` |
| 3 | L2391 `rejects a blank key that asks to keep outer spaces and also trim them` | `空白双关：水的化学式是` | `trim:false` + `normalization.trim_outer:true` | `trim-false-conflict-save` | `'trim_outer true'` |
| 4 | L2415 `rejects a blank key that asks to trim outer spaces and also keep them` | `空白反向双关：水的化学式是` | `trim:true` + `normalization.trim_outer:false` | `trim-true-conflict-save` | `'trim_outer false'` |

每行的输入对象与原 case 逐字段一致；断言面（`rejected` + 行专属 `JSON.stringify(saved.issues)` 片段）不削弱——没有退化成统一"拒绝"断言。

## 本地验证

- `pnpm exec biome check src/server/questions/edit-submit.db.test.ts`：通过，无 fix。
- `pnpm typecheck`（tsc --noEmit + server/start tsconfig）：通过。
- `pnpm audit:test-policy`（base `4fd179818`）：files=1、checked=1、inherited=27、errors=[] —— 合并 case 作为 changed case 通过准入。
- `pnpm audit:partition`：errors=[]。
- `pnpm build`：通过（既有 `INEFFECTIVE_DYNAMIC_IMPORT` 警告，与本次无关）。
- **NOT_RUN**：未运行任何 vitest / DB 测试——批准不含 DB 运行授权；完整 test gate 由 push 后 exact-head CI Gate 执行。`request_id` 去重路径与 rejected 行为的真实运行待 CI 验证。

## PR 描述须引用

- Owner B3 批准（2026-10-20 20:01 JST 状态页，经协调）。
- 方案路径 + SHA-256（见上）。
- 本文件与四行等价映射。
