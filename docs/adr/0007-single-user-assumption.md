# 单用户假设明文化 — 无 user_id，retrofit 成本承认

**决策**：本项目永久单用户。schema **不**含 `user_id` 列；auth 边界是 `middleware.ts` 的 `x-internal-token`；多设备同步走 export/import（Sub 5 落地）；多账户 / 协作 / 分享 **不支持**。

如果未来需要多用户（分享、协作、合规多账户），认了"重做 schema + auth + middleware"成本——这是 ADR 显式承担的负债，不是 surprise。

---

## 理由

1. **个人学习工具的 first principle**。CONTEXT.md / 项目愿景从来没说过多用户；所有 query / cron / agent 都假设"我自己"作为唯一主体。
2. **加 user_id 是不可逆的 schema 复杂度**：每张表多一列、每个 query 多一个 WHERE、每个 agent prompt 多一个隐含上下文。**单用户简化所有这些 50%**。
3. **export/import 已经是"换设备"路径**（Sub 5 落地）。多设备同步通过 ZIP roundtrip 解决，不需要 multi-tenant 服务端。
4. **完工前 draft 期单用户 → 没有 user-scoped 测试这件事不存在**；不写 user_id 不会产生测试缺口。

---

## 接受的代价

- **协作 / 分享 / 多账户场景需要重写**。**接受**——这是个人工具，承认它就是个人工具。
- **未来若要拆 frontend 让别人用，要做 oauth + user_id 全栈迁移**。**接受**——届时重新评估，可能直接 fork 出"协作版"项目。

---

## 触发重新评估的条件

- 想让另一个人用同一个部署 → 触发完整 multi-user retrofit ADR
- 出现合规 / 审计需求要求 per-user 数据隔离 → 同上
- 想做"分享一道错题"这种轻量协作 → 走 export-asset 单向，**不**改 schema

---

**相关：** ADR-0001（TS 单语种 / Python sidecar）—— 同样是"显式承担一个长期假设 + 标明触发换路径条件"的 ADR 模式。
