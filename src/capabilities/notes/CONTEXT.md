# notes — 笔记域（M3 采伐，YUK-317）

笔记旅程的承载包：artifact 笔记的读路径（note-page 单页聚合 / notes-read 按知识点标签 / `read_note` 给模型的正文与统计）、
写路径（body-blocks-edit 乐观锁块编辑 / block-refs L2 反链 write-through）、
generate durable handoff 与 Living Note refine 链（note-refine-{triggers,policy,proposals,apply}：
触发入队 pg-boss `note_refine` → 阈值门控 → 小改 mutator 直落（undo event）/ 大改 propose）。

- **表认领**：`artifact`、`artifact_block_ref`、`note_verification_claim`（YUK-1772 起只读旧行，不再写入）。
  注：`tool_quiz` 形态的 artifact 由 practice
  包过渡期跨域写（卷生成/session 链），M5 manifest 对账时统一裁。
- **D6 / YUK-358 决定3**（笔记内嵌判分自测孤儿链已真删）：refine 触发器五信号删
  `error_rate` 余四（mark_wrong/mastery_change/dwell/dreaming）；新信号源 = 流作答
  （mastery_change 经 practice submit persist 接入）。graded inline self-test 链
  （`/api/embedded-check/attempt` 路由 + `embedded_check_generate` 生成链 handler +
  `EmbeddedCheckGenerateTask` AI task + `artifact.embedded_check_status` 列 +
  note/node page 投影）已全部删除。`check` 段本身保留为 Phase-3 自解释锚点
  （ADR-0040 决定3），`NoteSection.embedded_check` 仍是合法 schema 槽（latent，无生产 writer）。
- **编辑 presence**：Notes 拥有 session 心跳、延迟 refine 队列与逐项应用/失败恢复；
  heartbeat/blur 由 Notes manifest 注册。持久化队列格式由 core schema 单一类型定义，表结构与锁协议不变。
- server/ — 模块本体（`note-handoff` 承载 append-only intent/completion 与 indexed recovery；
  `boss-port` 是唯一 Notes→boss
  接口）；tasks/ — NoteGenerateTask / NoteRefineTask 完整定义；jobs/ — note_generate /
  note-refine / hub_auto_sync_nightly（dreaming_nightly 留旧树，M4 夜链容器）；
  api/ — 10 条 route body。
- 包外主要消费方：knowledge/node-page（笔记 section + backlinks 聚合读）、orchestrator
  {learning_intent,teaching}、proposals/actions（note_update applier，M4 真身前留旧）、
  practice/grading/api/submit（enqueueMasteryNoteRefine）。
