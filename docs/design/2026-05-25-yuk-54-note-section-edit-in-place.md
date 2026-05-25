# YUK-54 Note Section Edit In Place

## Preflight

目标是在 atomic note 阅读页内直接编辑单个 section，同时保留现有 note markdown 渲染、embedded check 展示和 artifact 单写入口约束。

## Decisions

- 每个 section header 放一个小号 `Edit` 按钮；编辑态只展示当前 section 的 textarea、Save、Cancel。
- 保存入口是 `src/server/artifacts/sections.ts`。API route 只解析请求并调用 owner-service，不直接更新 `artifact`。
- 保存写 `artifact.sections`、`artifact.history`、`artifact.version`，并通过 `writeEvent` 写 `experimental:artifact_section_edit`。
- 事件 payload 固定包含 `artifact_id`、`section_id`、`section_index`、`previous_body_md`、`next_body_md`、`previous_version`、`next_version`。
- 前端在保存时先本地乐观替换 body/version；失败后恢复保存前 snapshot，并回到编辑态显示错误。
- markdown/read 与 textarea/edit 共用稳定容器高度，减少切换时的垂直跳动。

## Non Goals

- 不提升为 KnownEvent，不新增 ADR。
- 不引入协同编辑或多字段 section 编辑。
- 不改变 note generation / verification / embedded check 的既有写入语义。
