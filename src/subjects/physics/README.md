# subjects/physics/

Physics 学科 bundle。Subject #3，用于 Foundation 真 Closeout phase（spec `docs/superpowers/specs/2026-05-22-foundation-true-closeout-design.md`）。

## P-1 状态（2026-05-22）

仅 fixture seed：

- `fixtures/data.json` — 10 道 fixture（5 单位换算 + 3 量纲分析 + 2 公式应用）
- `fixtures/index.ts` — Zod schema + `loadPhysicsFixtures()` loader
- `fixtures/schema.test.ts` — schema 验证 + 数量分布 + 5 类 ExpectedSignal 覆盖测试

`expected_signals` 字段是 physics 子目录本地约定，为 P2 `unit_dimension@1` capability 的 4 错误路径测试预先布点（numeric_close / numeric_off / unit_mismatch_same_dimension / dimension_mismatch / missing_unit）。**不动 framework schema**。

## 下一步（按 Foundation 真 Closeout phase 序列）

- **P0**：写 `profile.ts`（SubjectProfile）+ `index.ts` re-export；`src/subjects/profile.ts` 注册 + DEFAULT_ALIASES 加 `'physics' / 'physical'`；profile validator 通过；fixture 端到端跑通（学习 → 答题 → judge → review 队列）；**Foundation B acid test 1**（framework diff = 0）
- **P1**：`src/core/capability/judges/unit_dimension.ts` skeleton + 注册；profile.judgeCapabilities += 'unit_dimension'；**Foundation A acid test 2**（registry / router 主体 0 行 diff）
- **P2**：unit_dimension@1 真实现（deterministic accelerator + LLM fallback + 4 错误路径 score 合成）
- **P3**：rating-advisor + UI advisory；**Foundation C acid test 3**（score 真贯穿 FSRS 调度）
- **P4**：closeout audit + status.md 收口

详 outline doc `docs/superpowers/plans/2026-05-22-foundation-true-closeout-phases.md`。

## 约束

- `core/` 不依赖 `subjects/`；`subjects/` 可依赖 `core/`
- 不在 `core/` 内引 physics-specific 逻辑；prompt fragments / cause taxonomy / 判分政策均在 profile 内声明
- Fixture 是开发期 seed，不入 prod migration；通过 dev seed endpoint（P0 仿 `app/api/_/seed/math/route.ts` 起）才能进 DB
