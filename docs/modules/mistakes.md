# 错题管理

> 见 [架构基础](../architecture.md) 了解 `Mistake` schema、FSRS state 和 AI 任务层。
> Quiz 答错触发的错题创建详见 [`quiz.md`](quiz.md)。

---

## 录入入口

四种入口都能产生 Mistake：

- 拍照 / 截图 → vision LLM 直接处理（跳过 OCR 中间层），由 `VisionExtractTask` 处理
- 手动粘贴（纯文本 / Markdown）
- 从 artifact 或会话中反向标记
- **Quiz 答错事件**（`Judgment.verdict in [partial, incorrect]` 自动创建 Mistake；`appeal 翻盘 → correct` 撤销 Mistake，标 `delete_reason='misjudged'`）

## AI 处理

入库时同步必跑：
- **归因**（`AttributionTask`）：概念不清 / 计算失误 / 审题 / 知识点缺失
- **挂载**：定位到一个或多个知识点
- **触发**：是否产生 LearningItem（见 [`learning-items.md`](learning-items.md)）

异步可批（夜间 batch）：
- **变式题生成**（`VariantGenTask`）：双 pass + `status: draft`，用户做一次确认才激活进复习池

## 复习调度

应试场景下 **FSRS** 比 SM-2 更合适。每道错题保留：
- 首次错时间 / 累计错次数 / 最近一次复习状态
- FSRS state（`due_at`, `interval`, `ease`, `repeat`, `lapses`）

复习触发：
- FSRS 到期自动入复习队列
- 每日 quiz 优先抽到期错题（见 [`lanes.md`](lanes.md)）
- Note 的 embedded check 错题反向入库（见 [`notes.md`](notes.md) § 6）

## 与其他模块的接口

| 接口 | 方向 | 说明 |
| --- | --- | --- |
| `link_mistake_to_node` | mistake → knowledge | 归因后挂载 |
| 触发 LearningItem | mistake → learning-items | 归因发现缺口时 |
| 喂 base mastery（错 / 对） | mistake → progress | FSRS retrievability 驱动 |
| 反向 propose 更新 note section | mistake → notes | 触发 living note |
| Maintenance: 删错题 / 重置 FSRS | maintenance → mistake | 走 MaintenanceSuggestion |
| **Mistake 自动创建（quiz 错）** | quiz → mistake | `from_judgment_id` 关联 |
| **Mistake 撤销（appeal 翻盘）** | quiz → mistake | soft delete + `delete_reason='misjudged'` |

## Schema

`Mistake` 详见 [架构基础 § 五](../architecture.md#五数据模型骨架)。新增字段：
- `from_judgment_id?` — 关联触发它的 Judgment（如果来自 quiz）
- `delete_reason?` — soft delete 时的原因（`user`/`merge`/`duplicate`/`misjudged`）

---

## 模块特定的待决策

- 视觉模型选型 baseline → **已定**：CMMMU + MMMU + 自定义 10~20 张样本三层评测，准确率 ≥ 80% 中选最便宜
- 变式题质量保证 → **已定**：双 pass + draft 状态，用户做后激活
- 错题截图的多题切分（一张图含多道题）— Phase 2 决策
- partial credit 错题的复习策略（是否跟 incorrect 同样进 FSRS）— 默认是
