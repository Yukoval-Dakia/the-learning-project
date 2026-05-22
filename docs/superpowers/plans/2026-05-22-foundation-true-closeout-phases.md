# Foundation 真 Closeout — Phase 大纲

> Phase-level outline for the Foundation 真 Closeout spec. Detailed task lists for each phase ship as separate plan docs when that phase starts (math MVP pattern：`2026-05-22-math-mvp-m2-1-steps-skeleton.md` 那一级).

**Spec source**: [`docs/superpowers/specs/2026-05-22-foundation-true-closeout-design.md`](../specs/2026-05-22-foundation-true-closeout-design.md)
**Date**: 2026-05-22
**Status**: outline only —— per-phase plan docs to follow as phases start.

## Phase 序列总览

| Phase | 主题 | 估时 | 关键 acid test | 独立 PR |
|---|---|---|---|---|
| P-1 | Preflight + 现状审计 + framework baseline + physics fixture seed | 1 day | — | 1 |
| P0 | Physics profile + Foundation B acid test (framework diff = 0) | 2-3 day | **acid test 1** | 1 |
| P1 | `unit_dimension@1` skeleton + Foundation A acid test (registry / router 0 行 diff) | 1-2 day | **acid test 2** | 1 |
| P2 | `unit_dimension@1` impl (deterministic + LLM fallback + 4 错误路径) | 3-4 day | — | 1 |
| P3 | partial → FSRS rating advisory + Foundation C acid test (score 真贯穿) | 2-3 day | **acid test 3** | 1 |
| P4 | Closeout audit + framework diff verification + status.md / v0.3 doc 收口 | 1-2 day | — | 1 |

**总估时**：10-15 day（2-3 周）。每 phase 独立 PR + 独立 reviewer 关卡 + 独立 audit 节奏，沿用 math MVP 已验证模式。

## Phase exit criteria 速查

详见 spec §3，下表只摘 must-pass：

### P-1
- [ ] Partial credit trace audit doc merged
- [ ] Framework diff baseline 写入 audit doc
- [ ] 10 道 physics fixture json 落地
- [ ] Wenyan + math regression 通过

### P0
- [ ] Physics 10 道 fixture 走完闭环
- [ ] `git diff main -- <framework paths>` 为空（**acid test 1** 通过）
- [ ] Profile validator 通过
- [ ] Wenyan + math fixture regression 通过

### P1
- [ ] `unit_dimension@1` 注册到 registry，能被 route resolver 命中
- [ ] **acid test 2** 通过（registry.ts + router 主体 0 行 diff，仅 `judges/index.ts` + 1 行 register 调用）
- [ ] Profile validator 通过

### P2
- [ ] 10 道 physics fixture 4 类错误路径正确分类
- [ ] LLM fallback 路径有 mock 测试覆盖
- [ ] Wenyan + math regression 通过
- [ ] 框架代码 LOC change = 0（不在 unit_dimension.ts / physics 子目录之外）

### P3
- [ ] `judgeResultToRatingAdvice` 6 分支全测过
- [ ] Physics + math partial 题在 review UI 显示 advisory 并默认 highlight 推荐档
- [ ] Submit event payload 含 judge_advice（partial 题 100% 覆盖）
- [ ] Wenyan correct 题 regression 通过
- [ ] 框架 diff = `rating-advisor.ts` 新文件 + review submit 增 1 字段 + review UI 增 advisory 组件；FSRS 内核 ABI 不变（**acid test 3** 通过）

### P4
- [ ] `/audit-drift` 0 new finding
- [ ] Framework diff 与 P-1 baseline 对齐
- [ ] status.md / v0.3 doc Foundation A/B/C 段更新
- [ ] N+1 follow-ups 列入 closeout doc

## Per-phase plan doc to write

每个 phase 启动前写细 plan doc（如 math MVP `2026-05-22-math-mvp-m2-1-steps-skeleton.md` 级别），命名约定：

- `docs/superpowers/plans/2026-05-2X-foundation-closeout-p-1-preflight.md`
- `docs/superpowers/plans/2026-05-2X-foundation-closeout-p0-physics-profile.md`
- `docs/superpowers/plans/2026-05-2X-foundation-closeout-p1-unit-dimension-skeleton.md`
- `docs/superpowers/plans/2026-05-2X-foundation-closeout-p2-unit-dimension-impl.md`
- `docs/superpowers/plans/2026-05-2X-foundation-closeout-p3-rating-advisory.md`
- `docs/superpowers/plans/2026-05-2X-foundation-closeout-p4-closeout.md`

Per-phase plan doc 包含（仿 math MVP 模板）：Goal / Architecture / Spec source / Spec deltas / Boundaries / File Structure / 任务清单（checkbox tracking）。

## 依赖关系图

```
P-1 ─┬─ P0 ─┬─ P1 ─ P2 ─┐
     │      │            ├─ P4
     └──────┴─ P3 ───────┘
```

- P-1 是 baseline + fixture 落地，所有后续 phase 都依赖
- P0 physics profile 必须先于 P1（profile 声明的 capability 要存在）
- P1 skeleton 必须先于 P2（impl 替换 skeleton）
- **P3 与 P0/P1/P2 并行可行**：rating advisor 不依赖 physics 是否落地，只要 partial 信号源（math steps@1 already shipped）就能开发。若有并行精力，P3 可与 P0+P1 并发；P2 因有 LLM fallback 验证需要，单独一段时间窗。
- P4 依赖所有前面 phase 完成

## N+1 / N+2 候选（spec §8 已列，本 doc 不展开）

- subject #4（programming / english）
- partial → mastery view
- partial → FSRS Option B/C 评估
- physics 图像题 capability
- schedulinghints 按 cause 调整 interval
- advisory acceptance rate 分析与阈值调整
