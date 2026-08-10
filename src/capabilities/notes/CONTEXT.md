# notes — 笔记域（M3 采伐，YUK-317）

笔记旅程的承载包：artifact 笔记的读路径（note-page 单页聚合 / notes-read 按知识点标签）、
写路径（body-blocks-edit 乐观锁块编辑 / sections / block-refs L2 反链 write-through /
hub-dismiss）、generate/verify durable handoff 与 Living Note refine 链（note-refine-{triggers,policy,proposals,apply}：
触发入队 pg-boss `note_refine` → 阈值门控 → 小改 mutator 直落（undo event）/ 大改 propose）。

- **表认领**：`artifact`、`artifact_block_ref`、`note_verification_claim`。后者仅承载
  NoteVerifyTask 的付费调用 fence/result recovery，不是通用 job framework；`retry_wait` 可保留
  `result_json`，但只供定时恢复做有界 parse/finalize 重试。定时恢复可为 expired pre-wire
  reservation / 新 artifact epoch 写入可重发现的无 task/result `retry_wait`，再投递
  fence-specific `note_verify` job，但自身绝不执行付费 AI；
  provider attempt 在 central runner durable start 后、真实 query 前按 artifact epoch 原子计数，
  最多 3 次；pre-wire failure 不计数，达到上限时同事务投影 claim `attempts_exhausted` 与
  artifact `verification_status='failed'`，只有新 epoch 重置。
  expired provider-start 只会 fail-closed 为 ambiguous。上述 handoff/claim 与 hub reconcile 共用
  manifest 中唯一的 `hub_sync_recovery` 定时 floor；两分支隔离执行，任一失败仍让 job retry-visible。
  注：`tool_quiz` 形态的 artifact 由 practice
  包过渡期跨域写（卷生成/session 链），M5 manifest 对账时统一裁。
- **D6 / YUK-358 决定3**（笔记内嵌判分自测孤儿链已真删）：refine 触发器五信号删
  `error_rate` 余四（mark_wrong/mastery_change/dwell/dreaming）；新信号源 = 流作答
  （mastery_change 经 practice submit persist 接入）。graded inline self-test 链
  （`/api/embedded-check/attempt` 路由 + `embedded_check_generate` 生成链 handler +
  `EmbeddedCheckGenerateTask` AI task + `artifact.embedded_check_status` 列 +
  note/node page 投影）已全部删除。`check` 段本身保留为 Phase-3 自解释锚点
  （ADR-0040 决定3），`NoteSection.embedded_check` 仍是合法 schema 槽（latent，无生产 writer）。
- **不搬区**：`src/server/artifacts/{editing-session.ts,presence/}` 留旧位置——dwell 遥测
  / 编辑心跳是 ⚖️ 争议行（spec §3.6），未裁前 `/api/editing-session/*` 继续旧栈服务。
- server/ — 模块本体（`note-handoff` 承载 append-only intent/completion 与 indexed recovery；
  `note-verification-claim` 承载 artifact-version/fence/token 状态机；`boss-port` 是唯一 Notes→boss
  接口）；tasks/ — NoteGenerateTask / NoteVerifyTask 完整定义；jobs/ — note_generate / note_verify /
  note-refine / hub_auto_sync_nightly（dreaming_nightly 留旧树，M4 夜链容器）；
  api/ — 9 条 route body（T4 填，kernel v2 签名）。
- 包外主要消费方：knowledge/node-page（笔记 section + backlinks 聚合读）、orchestrator
  {learning_intent,teaching}、proposals/actions（note_update applier，M4 真身前留旧）、
  practice/api/submit（enqueueMasteryNoteRefine）。
