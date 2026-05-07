# 错题管理

> 见 [架构基础](../architecture.md) 了解 `Knowledge` / `Mistake` / FSRS state schema 和 AI 任务层。

---

## 录入入口

- 拍照 / 截图 → vision LLM 直接处理（跳过 OCR 中间层）
- 手动粘贴（纯文本 / Markdown）
- 从 artifact 或会话中反向标记

## AI 处理

入库时同步必跑：
- **归因**：概念不清 / 计算失误 / 审题 / 知识点缺失
- **挂载**：定位到一个或多个知识点
- **触发**：是否产生 LearningItem（见 [`learning-items.md`](learning-items.md)）

异步可批（夜间 batch）：
- **变式题生成**：结果先 draft，做完确认才进复习池

## 复习调度

应试场景下 **FSRS** 比 SM-2 更合适。每道错题保留：
- 首次错时间 / 累计错次数 / 最近一次复习状态
- FSRS state（`due_at`, `interval`, `ease`, `repeat`, `lapses`）

## Schema

`Mistake` 详见 [架构基础 § 五](../architecture.md#五数据模型骨架)。

---

## 模块特定的待决策

- 第一个落地的应试场景：?（决定 Phase 1 课标 import 范围）
- 视觉模型 eval：MiMo / Qwen-VL / Haiku vision 在真实题型上的对比基准
- 变式题生成的质量保证（Embedded check 的反向信号是否也用于变式题筛选）
