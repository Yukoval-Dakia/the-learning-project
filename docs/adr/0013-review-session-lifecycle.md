# ADR-0013 — `/review` 开 learning_session(type='review') 行

**状态**：accepted
**日期**：2026-05-17
**前置**：ADR-0005（single-owner session）、ADR-0008（multi-type session envelope）、ADR-0006 v2（event-driven core）

---

## 决策

`/review` 页打开时 **eager** 创建一条 `learning_session(type='review', status='started')`，所有该 session 内的 `review` event 都用此 session_id 落库；页退出时 `sendBeacon` 触发 `complete`；fallback 由 daily 清理 cron 把超过 6h 仍 `started` 的 review session 标为 `abandoned`。

**不**选「lazy 创建 / 不开 session」两条路；理由见 §"Considered alternatives"。

---

## 背景

Phase 1c.1 ADR-0008 已经把 `learning_session.type='review'` 的状态机定下（`started → completed | abandoned`），`src/server/session/review.ts` 全部 transition 函数齐备并已测，但 `app/api/review/submit/route.ts:123` 仍然写 `session_id: null` —— **机器已造好，电没接上**。

结果：

- `/today` ribbon 看不到「今天复习了几个 session」、「平均一个 session 多少张卡」之类的指标
- 没法触发 session-end AI 总结（RESUME.md item #2 卡在这里）
- 周度 review 报表（Phase 1d 计划项）只能按"event 流"统计，丢失 session 边界

新增 `/events/[id]` 浏览器已经支持 session_id 上链；如果 review event 仍是 session_id=null，未来再去补 backfill 比"现在就开"贵。

---

## 选项

### A. Eager — `/review` 页打开即建 session（**accepted**）

- 客户端：`/review` 页 mount 时 POST `/api/review/sessions` → 拿 `sessionId`，存 React state + URL `?session=<id>`
- 每次 POST `/api/review/submit` 带 `session_id`；route 用它写到 event row
- 页面卸载：`window.addEventListener('pagehide', ...)` + `navigator.sendBeacon('/api/review/sessions/<id>/end', {status:'completed'})`
- 兜底 cron：每日扫 `learning_session WHERE type='review' AND status='started' AND started_at < now() - 6h` → 标 `abandoned`

**优点**：

- 立刻打通 session-end 总结路径（RESUME #2）
- /today + 周度 review 自动能按 session 切片
- 状态机 + transition 函数已经写好且 100% 测试覆盖，「接电」只需 1 个新 route + 客户端 sendBeacon + cron 兜底
- session 是「事件流」的天然分块单元，避免日后追加 grouping 字段

**接受的代价**：

- 「打开就走」用户会留下空 session（无 review event）—— 接受，cron 标 abandoned 即可，对单用户量小不污染
- 多设备 / 多 tab 同时打开 `/review` 会产生并行 session —— 接受，每个 tab 独立 session 是合理的；前端不做跨 tab 单例
- 用户手动刷新页面会 abandon 旧 session 开新 session —— 接受，刷新意味着重启上下文

### B. Lazy — 第一次 submit 时才建 session

- 第一次 POST `/api/review/submit` 不带 sessionId → route 内同事务建 session + 写 event
- 后续 submit 客户端记住返回的 sessionId 复用
- 关页用 sendBeacon close

**为什么不选**：

- 让 `/api/review/submit` 兼带 "可能开 session" 副作用，违反 ADR-0005 "single-owner transition" 原则
- 客户端要管 "上一次返回的 sessionId 是不是仍属于本次会话" 的状态
- 取消的边界：连续两次刷新但没 submit 的页面，永远不产生 session row —— 看似省了一行，但 /today 此时也看不到「用户点开过 review 0 次成功」的信号
- 与 ingestion session（eager 创建）的契约不一致

### C. 不开 session

- 维持现状（session_id 永远 null）
- 周度 review 报表按 event 流统计

**为什么不选**：

- 直接堵死 session-end 总结路径（关键 Phase 2/3 阻塞项）
- ADR-0008 enum 占位了 `type='review'`，不接电相当于 ADR-0008 被废一半 —— 要么改 ADR-0008 把 review 拿掉，要么接电；不接电是中间态
- session 是用户语义上的「学习单元」—— 错过这个边界后日后想补极贵

---

## 实施计划

仅 sketch，不属于 ADR 决议范围：

1. **新 route**：`POST /api/review/sessions` → 调 `startReviewSession(db)` 返回 `{ sessionId }`
2. **新 route**：`POST /api/review/sessions/[id]/end` 接 `{ status: 'completed' | 'abandoned' }` → 调对应 transition；接受 `text/plain` body 兼容 sendBeacon
3. **改 route**：`POST /api/review/submit` body 加可选 `session_id` 字段；route 写 event 时 `session_id` 取自 body
4. **改客户端**：`/review` 页 mount + unmount 钩子；URL `?session=<id>` 持久化
5. **新 cron**：`prune_orphan_review_sessions` 每日扫 6h+ started 状态的 review session → abandon。schedule `15 4 * * *` BJT（在 prune_job_events 之后）
6. **测试**：route 单元 + 端到端 page → submit → end 流；orphan cron 6h cutoff 验证

每步 commit 独立、reversible。

---

## 触发重新评估

- 用户跨 tab 行为产生大量并行 session 噪音 → 加客户端单例锁，**不**回退到 lazy
- AI session-end 总结实际上不需要 session 边界（例：用 fixed 时间窗代替）→ 评估是否把 review session 改为 lazy
- 多设备并发同步引入冲突 → ADR-0007 单用户假设松绑后单独评估，**不**回退本 ADR

---

## 演化关系

- **实施 ADR-0008**：拿掉 "type='review' 但行为待补" 这块尾巴，让 ADR-0008 的承诺真落地
- **解锁** session-end AI 总结（RESUME.md 桌上项 #2）+ 周度 review 报表（Phase 1d 计划）
- **不破坏** ADR-0005 single-owner / ADR-0006 v2 event-driven core / ADR-0007 单用户假设

> **M5 路径注（YUK-321，2026-06-13）**：本文提及的 `app/api/**` Next route 路径已随旧栈拆除迁移至 capability manifests（`src/capabilities/*/manifest.ts` + 各包 `api/*.ts`），由组合根 `server/app.ts` 挂载；决策本身不受影响。
