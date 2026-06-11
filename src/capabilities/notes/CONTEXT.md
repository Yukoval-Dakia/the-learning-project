# notes — 笔记域（M3 采伐，YUK-317）

笔记旅程的承载包：artifact 笔记的读路径（note-page 单页聚合 / notes-read 按知识点标签）、
写路径（body-blocks-edit 乐观锁块编辑 / sections / block-refs L2 反链 write-through /
hub-dismiss）与 Living Note refine 链（note-refine-{triggers,policy,proposals,apply}：
触发入队 pg-boss `note_refine` → 阈值门控 → 小改 mutator 直落（undo event）/ 大改 propose）。

- **表认领**：`artifact`、`artifact_block_ref`。注：`tool_quiz` 形态的 artifact 由 practice
  包过渡期跨域写（卷生成/session 链），M5 manifest 对账时统一裁。
- **D6 墓碑**（笔记内嵌自测已裁删）：refine 触发器五信号删 `error_rate` 余四
  （mark_wrong/mastery_change/dwell/dreaming）；新信号源 = 流作答（mastery_change 经
  practice submit persist 接入）。embedded-check attempt route / 生成链 handler /
  `artifact.embedded_check_status` 列原地墓碑，M5 拆除采石场统一清。
- **不搬区**：`src/server/artifacts/{editing-session.ts,presence/}` 留旧位置——dwell 遥测
  / 编辑心跳是 ⚖️ 争议行（spec §3.6），未裁前 `/api/editing-session/*` 继续旧栈服务。
- server/ — 模块本体（测试同居，命名即分区）；jobs/ — note_generate / note_verify /
  note-refine / hub_auto_sync_nightly（dreaming_nightly 留旧树，M4 夜链容器）；
  api/ — 9 条 route body（T4 填，kernel v2 签名）。
- 包外主要消费方：knowledge/node-page（笔记 section + backlinks 聚合读）、orchestrator
  {learning_intent,teaching}、proposals/actions（note_update applier，M4 真身前留旧）、
  practice/api/submit（enqueueMasteryNoteRefine）。
