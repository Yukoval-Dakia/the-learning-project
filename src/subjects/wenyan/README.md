# 文言文（subject bundle）

Phase 1 首发数据集（高中语文）。预期内容：

- 高中语文文言文课标导入（AI 自动建议节点 + 人工确认）
- 学科特化 prompt 片段（实词 / 虚词 / 句式 / 翻译题型评分细则）
- 已有模拟卷数据（如有）

## 边界规则

- `subjects/wenyan/` 可以引用 `core/`
- `core/` **不**反向依赖 `subjects/*`
- 真出现第二学科再考虑抽 plugin loader（见 PLANNING.md Phase 3）
