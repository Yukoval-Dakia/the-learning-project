# subjects/wenyan/

文言文学科 bundle。Phase 1 首发数据集。

- `curriculum.json` — 课标知识点 seed（Knowledge schema 的 source records）
- `seed.ts` — 把 curriculum.json transform 成 DB insert payload 的 helper
- `index.ts` — 包入口

**约束**：`core/` 不依赖 `subjects/`；`subjects/` 可依赖 `core/`。
