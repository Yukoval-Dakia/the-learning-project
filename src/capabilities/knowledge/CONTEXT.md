# knowledge — 知识域（M3 采伐，YUK-317）

认知结构的承载包：树（tree 全量快照 + OOM guard）、边（knowledge_edge CRUD + 提议链）、
节点页聚合（node-page 六维读：metadata/mastery/neighbors/atomics/backlinks/timeline+notes）、
提议双链（节点 propose / 边 propose_edge，rubric-validator 两层校验，proposals
accept/dismiss 带 FOR UPDATE 防并发）、错因归因（attribute → JudgeOnEvent）、
科目派生（domain / subject-resolution / subject-profile）。

- **表认领**：`knowledge`、`knowledge_edge`、`knowledge_mastery`。
- **红线：科目是视角不是结构**——subject 一律经 `getEffectiveDomain` 派生轴
  （parent-chain walk），任何实体加 subject 列是违例；树按认知结构生长，永远不动树。
- **跨包读**：node-page 的笔记 section / backlinks 经 notes 包导出
  （notes-read / body-blocks / block-refs），方向单一（knowledge → notes）。
- server/ — 16 模块本体（测试同居，命名即分区）；jobs/ — 主依赖为 knowledge 的
  boss handlers（propose / edge-propose / attribution 类，实施时按依赖核对归位）；
  api/ — 8 条 route body（T4 填，kernel v2 签名）。
- 包外主要消费方：practice / ingestion 包（getEffectiveDomain /
  resolveSubjectProfileForKnowledgeIds / assertKnowledgeIdsExist / batchResolveSubjectIds）、
  AI tools 簇、boss handlers（quiz_verify 等）。导出名保持不变，只动 import 路径。
