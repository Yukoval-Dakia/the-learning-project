# subjects/yuwen/

语文学科 bundle（id `yuwen`；旧 id `yuwen` 已降为 alias，见 subjects/profile.ts）。
当前内容子域是文言文（Phase 1 首发数据集）——扩科时留位、内容后补。

- `curriculum.json` — 课标知识点 seed（Knowledge schema 的 source records）
- `seed.ts` — 把 curriculum.json transform 成 DB insert payload 的 helper
- `index.ts` — 包入口

**约束**：`core/` 不依赖 `subjects/`；`subjects/` 可依赖 `core/`。
