# IngestionSession — 录入会话状态机的单一所有者

**决策**：`src/server/ingestion/session.ts` 是**唯一**可以写入 `ingestion_session.status` 和 `question_block.status` 的代码位置。任何 route handler / pg-boss handler / 服务函数都**不允许**直接 `db.update(ingestion_session)…status = …` 或 `db.update(question_block)…status = …`。所有状态迁移必须调用模块导出的 transition 函数（`initiateUpload` / `enqueueExtraction` / `markExtractionStarted` / `applyExtractionResult` / `markExtractionFailed` / `applyRescue` / `markReviewed` / `commitImport`），由模块内部守卫 from-state、写 `job_events`、保证事务原子性。

状态机定义见 `CONTEXT.md` "录入会话" 词条；调用者清单见 `docs/architecture.md` "录入会话状态机" 章节。

---

## 理由

1. **领域名词须有代码归宿。** "录入会话" 是 `CONTEXT.md` 头等概念，状态机却历史性地散在五处写入位置（`POST /api/ingestion`、`/extract`、OCR handler、`/rescue`、`/import`），每处自带 from-state 校验和 invariant 守卫，且各不相同（例：原 `import/route.ts:67-70` 接受 `extracted | reviewed`，但 `partial` 是否可 import 没人定）。模块化让"会话能发生哪些事"在一个文件里看完，符合 AI 可导航性原则。
2. **Sub 0c 异步 lane 加剧问题。** 新引入 `queued` / `extracting`，写入位置从 5 处扩到 7+；不收口则破窗成本随每次迭代复利上升。
3. **`job_events` + SSE 需要统一观察点。** Sub 0c 的 SSE-as-source-of-truth 要求每次状态迁移**同事务内**写 `job_events`。散落式写入意味着每个调用方都得记得加这一行——模块化用一个公共封装替掉七份重复。
4. **测试聚焦。** Transition 表（合法迁移 / 非法迁移 → `ApiError('conflict', 409)`）一份单测就覆盖完；route / handler 测试退化为"我调对了模块吗"，不再重新测状态机。

---

## 接受的代价

- **模块会胖。** `commitImport` lift 自 `import/route.ts` 的 ~355 行逻辑（virtual block 创建 + ignored sweep + question/mistake INSERT），下沉后 `session.ts` 不会小。**接受**——它们逻辑上本就是同一个状态迁移；继续散在 route 里更糟。
- **顺手改一行 status 要走模块。** 任何"就改个状态值"的 patch 都不能内联，必须经过 transition guard。**接受**——这就是我们要的"破窗成本"。
- **新加状态/transition 需改模块 + 测试 + CONTEXT.md 词条。** 三处同步更新有摩擦，但**这正是我们想要的摩擦**——它强制 transition 进入领域语言而非偷偷增长。

---

## 触发重新评估的条件

- **`session.ts` > 500 行**且测试难导航 → 按 transition cluster 拆（如 `session/core.ts` + `session/commit.ts`），但**保留 single-owner invariant**——拆文件不拆所有权。
- **新领域概念需要不符合 transition 语义的写入**（如未来的"session 分享"或"导出快照"等只读快照机制）→ 重新审视边界。但 status 字段的写入权不让出。

---

**相关：** ADR-0002（抽取层 = 确定性 OCR）定义了进入会话的"内容"约束；本 ADR 定义了会话"生命周期"约束。两者正交、互补。

**演化（2026-05-14）：** [[ADR-0008]] 把本 ADR 的 single-owner invariant 扩展到全 session type。`src/server/ingestion/session.ts` 演化为 `src/server/session/` 多态模块，ingestion 子状态机作为其中一支保留；本 ADR 的所有规约（守卫、事务原子性、`job_events` 同事务写入）在更大 scope 内继续有效。
