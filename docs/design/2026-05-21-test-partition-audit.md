# Test Partition Audit — Design

**Status**：方案 A 已实施（`scripts/audit-test-partition.ts` + `pnpm audit:partition`）。方案 B 待触发。
**Related**：
- [`vitest.shared.ts`](../../vitest.shared.ts) — `fastTestInclude` allowlist 单一源
- [`docs/superpowers/plans/2026-05-21-test-feedback-loop-optimization.md`](../superpowers/plans/2026-05-21-test-feedback-loop-optimization.md) — vitest 拆分原始 plan

## 背景

vitest 配置拆 unit/db/migration 后，`fastTestInclude` 是手写 allowlist（当前 46 个 test 文件）。两类漂移风险：

- **P0**：test 在 fastTestInclude 但实际触达 DB → `pnpm test:unit` runtime crash
- **P1**：test 不在 fastTestInclude 但无 DB 依赖 → 默默跑慢

## 方案 A（已实施）：file-level grep

`scripts/audit-test-partition.ts` 扫每个 `*.test.ts` 的**直接 import**，检测：

- npm 包：`postgres`、`drizzle-orm`、`drizzle-kit`、`pg`、`pg-boss`、`@testcontainers/postgresql`、`testcontainers`
- alias：`@/db/*`、`@/server/boss/*`
- 相对路径 resolve 后落在 `DB_TAINTED_DIRS`（`src/db/`、`src/server/boss/`）之下
- 同时记录 `vi.mock(...)` —— mock 掉的 DB import 视为 unit-safe

输出：
- P0 ERROR（非零 exit）— `unit + 未 mock 的 DB import`
- P1 WARN（仅打印）— `db 但无 file-level DB import`
- unmatched — `不被任何 config 收`

复杂度：~170 行 TS，**无新依赖**。

### 已知漏报

- 通过 `import { foo } from '@/server/baz'`，baz 内部 import db → A 未抓到（不递归）
- 间接 chain 由 `pnpm test:unit` 实际跑时的 runtime crash 兜底（CI 抓得到，但开发循环慢）

## 方案 B（升级路径）：transitive analysis

当方案 A 漏报频繁出现，升级到 B。

### 工具选型：`dependency-cruiser`

理由：
- 成熟稳定，原生 TS + tsconfig paths alias 支持
- 配置即代码（`.dependency-cruiser.cjs`）
- rule 表达力强：可表达"任何 fastTestInclude 内的 `*.test.ts`，禁止 transitive 触达 `src/db/`"
- 输出 JSON + html / dot，便于 debug

### 实施草案

`.dependency-cruiser.cjs`：

```js
module.exports = {
  forbidden: [
    {
      name: 'unit-test-no-db-transitive',
      severity: 'error',
      from: { path: '^(fastTestInclude 模式编译后的 regex)' },
      to: {
        path: '^(src/db|src/server/boss|tests/helpers/db)',
      },
    },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
};
```

`scripts/audit-test-partition.ts` 改为 wrapper：

1. 从 `vitest.shared.ts` 取 `fastTestInclude`
2. 动态注入到 dependency-cruiser config（glob → regex）
3. spawn `depcruise --config .dependency-cruiser.cjs --output-type json <files>`
4. 用 vi.mock allowlist 过滤 false positive
5. 输出与方案 A 同样的 P0/P1/unmatched 三段报告

新依赖：`dependency-cruiser`（devDep，~5MB）

### 升级触发条件

满足**任一**即升级到 B：

- 方案 A 出现 ≥3 次"runtime crash 由 test:unit 抓到的 P0 漂移"
- `fastTestInclude` 增长到 ≥80 个文件
- 出现一次"漂移漏报 → 慢测试上线一周才发现"事件
- math M2 收尾后做一次全量 audit，发现 ≥5 个 P1 false negative（应入 unit 没入）

### 什么时候**不**升级

- 方案 A 稳定（P0 持续为 0、人工 audit 一致）
- 维护负担 < dependency-cruiser 的引入成本
- 项目仍单人维护（review burden 低）

## 维护手册（方案 A）

### 新增间接依赖 DB 的目录

如新建 `src/server/queue/` 且内部 import pg-boss，加进 `DB_TAINTED_DIRS`：

```ts
const DB_TAINTED_DIRS = ['src/server/boss/', 'src/db/', 'src/server/queue/'];
```

### 新加 unit test 的标准流程

1. 写 test，所有 DB import 都用 `vi.mock(...)`
2. 在 `vitest.shared.ts` 的 `fastTestInclude` 加 glob
3. `pnpm audit:partition` —— P0 = 漂移，0 = OK
4. `pnpm test:unit` —— runtime 确认

### 命中 P1 WARN 的判断

两种情况：
1. test 确实应入 unit（detector 正确）→ 加进 `fastTestInclude`
2. test 通过非典型路径触达 DB（detector 漏）→ 加目录进 `DB_TAINTED_DIRS` 或拓宽 `DB_PATH_PATTERNS`

### 已知限制

- 不解析 `import()` 动态 import
- 不解析 `require()`（项目 ESM-only，应无问题）
- 不展开 `index.ts` barrel re-export 的间接路径
- 不递归 transitive chain（方案 B 覆盖）
- DB-tainted 目录是手维护清单
