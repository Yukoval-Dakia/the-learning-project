---
name: audit-drift
description: 检测 ADR / planning-doc ↔ 代码实现之间的漂移。手动触发，输出 markdown 报告到 docs/audit/。配套 schema 漂移由 pnpm audit:schema 管，本 skill 处理结构性 / 语义层面。Use when user says "audit drift", "看漂移", "/audit-drift", or asks if code matches docs.
---

# Audit Drift

防止 ADR / 设计决策 ↔ 代码实现 漂移。Schema 字段漂移由 `pnpm audit:schema` 处理（确定性 lint）；本 skill 处理**结构性 / 语义层面**的漂移。

## 执行步骤

### 1. 列决策清单

读：
- `docs/adr/*.md`（所有 ADR）
- `CLAUDE.md`（Architecture / Layering / Design principles 三段）
- `docs/superpowers/plans/*.md`（活跃 plan）
- `docs/design/*.md`（最近 30 天）

抽取每个**可验证的决策点**——能在代码里找到证据的那种。**忽略**纯设计语录、纯前置说明。

### 2. 代码扫描

对每个 decision，定向查证据：
- ADR 提了具体 path / 符号 → 直接 `Read` / `Grep` 那个
- ADR 只提了概念 → 找概念关键词在 `src/`、`app/`、`scripts/` 的出现
- **不要全文 Read 整个 codebase**——只查 ADR 点名的位置

### 3. 分类

| 类别 | 含义 | 行动 |
|---|---|---|
| ✅ Aligned | 决策有，代码体现 | 不报 |
| ⚠️ Documented-only | ADR 写了，代码没实现 | 报 |
| ⚠️ Undocumented | 代码做了 ADR 没追认 | 报 |
| ❌ Contradicted | 代码做了 ADR 禁止的 / 反过来 | 优先报 |
| ⏳ Phase-deferred | ADR 写明延迟到 Phase X，当前不在 X | 不报 |

### 4. 报告

写到 `docs/audit/YYYY-MM-DD-drift.md`（用今天日期）：

```markdown
# Drift Audit — YYYY-MM-DD

**Scope**: ADR-NNNN..ADR-MMMM, plans/<active>, CLAUDE.md
**Run by**: Claude Code (manual /audit-drift)

## Summary
- Aligned: N（不展开）
- Documented-only: N
- Undocumented: N
- Contradicted: N
- Phase-deferred: N (informational)

## Findings

### ❌ Contradicted (优先)

#### [ADR-NNNN §3.2] <Decision summary>
- **声明**: <ADR 引用，≤ 2 行>
- **代码**: `src/path/file.ts:L42`，做了 X
- **冲突**: <一句话说清楚>
- **建议**: <修 code / 改 ADR / 加 deprecation>
- `gh issue create`:
  ```bash
  gh issue create --title "Drift: <ADR-NNNN> ↔ <file>" --label drift --body "..."
  ```

### ⚠️ Undocumented
（同样格式）

### ⚠️ Documented-only
（同样格式）
```

### 5. 不做的事

- ❌ 不自动开 issue（命令写在报告里，用户 copy）
- ❌ 不自动 commit / PR
- ❌ 不重审 schema 字段（`pnpm audit:schema` 管）
- ❌ 不全 codebase Read（targeted 查证）
- ❌ 不超 100 行报告 / 不超 15 条 finding（top-15 by risk）

## 假阳性防控

- **Phase 标签**：ADR 文末 / status 段写 "Phase 1c+" 之类——不在当前 Phase 不算 drift
- **Allowlist**：`scripts/audit-drift-allowlist.json`（首次跑不存在，误报多了再写）
- **历史 sweep**：第一次跑可能误报老 ADR；只标记**过去 30 天**有 commit 涉及的 decision

## 信号校准

跑完 2-3 次后回看：
- 假阳性率 < 30% → 考虑 cron 化（GitHub Action + 自动开 issue）
- 假阳性率 ≥ 30% → refine 这个 prompt，不要急着自动化
