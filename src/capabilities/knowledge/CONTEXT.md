# knowledge — 知识域（M3 采伐，YUK-317）

认知结构的承载包：知识树读面（GET /api/knowledge → readLearnerKnowledgeTree：按 subject + learner
可见性过滤、kernel OOM guard 上限）、知识点与边（knowledge / knowledge_edge CRUD + 提议链）、节点页聚合（node-page 六维读：metadata/mastery/neighbors/atomics/backlinks/timeline+notes）、
提议双链（节点 propose / 边 propose，rubric-validator 两层校验，proposals
accept/dismiss 带 FOR UPDATE 防并发）、知识点创建/归档与合并归属修复
（merge-attribution-backfill）。

- **表认领**：`knowledge`、`knowledge_edge`。
- **红线：科目是视角不是结构**——subject 一律经 `getEffectiveDomain` 派生轴
  （parent-chain walk），任何实体加 subject 列是违例；树按认知结构生长，永远不动树。
- **跨包读**：node-page 的笔记 section / backlinks 走 kernel `read-models/notes-read` 与
  `artifact-backlinks`，不直接 import notes 包。
- server/ — 模块本体（测试同居，命名即分区）；jobs/ — frontier_fill_nightly /
  knowledge_maintenance_nightly / kc_dedup_nightly / merge_attribution_sweep /
  projection_oracle_sweep / solution_prior_prereq_nightly（已准入解法先验里
  至少两题共同支持的先修对；一道题只有恰好一个仍在用的知识点时才计入，来源后来
  改为不可派生的题不计入；驳回过的同一对不再提议；只提议、不自动通过）；api/ — route body，由 manifest 的 load thunk 懒加载。
- 包外消费方：practice / ingestion 经 kernel 读模型取知识点与 subject 派生（knowledge-tree /
  subject-profile / knowledge-validate / subject-resolution）；server 的 revert、proposal
  undo-guard、admin 配置事实与 agency 的 FailureAttempt 类型走 public.ts。
