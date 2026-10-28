# YUK-54 Note Section Edit In Place Plan

## Scope

实现 atomic note section 原地编辑：显式进入编辑态、保存/取消、服务端单写入口、事件日志可查询、前端乐观更新和失败回滚。

## Steps

1. 补服务层 DB 测试：成功编辑持久化 sections/history/version，并写 `experimental:artifact_section_edit`；stale version 不写入。
2. 补 API route 测试：PATCH section 后，通过 learning-item detail GET 重载可见更新后的 markdown。
3. 补组件测试：渲染 Edit / Save / Cancel 控件，编辑容器稳定，乐观状态 helper 支持 rollback snapshot。
4. 实现 `src/server/artifacts/sections.ts` owner-service。
5. 实现 `app/api/artifacts/[id]/sections/[sectionId]/route.ts`。
6. 接入 `ArtifactSections`：本地 sections state、textarea 编辑态、Save/Cancel、乐观更新、错误回滚。
7. 在 learning-item detail 传入 artifact id/version，并在保存成功后 invalidate detail/list query。
8. 更新 `step9-invariant-audit.test.ts` artifact writer allowlist。
9. 运行聚焦 unit/db/lint/typecheck 验证并提交。

## Verification

- `pnpm vitest run --config vitest.unit.config.ts src/ui/components/ArtifactSections.test.tsx`
- `pnpm vitest run --config vitest.db.config.ts src/server/artifacts/sections.test.ts app/api/artifacts/[id]/sections/[sectionId]/route.test.ts tests/integration/step9-invariant-audit.test.ts`
- `pnpm lint <changed files if supported, otherwise biome check changed paths>`
- `pnpm typecheck`
