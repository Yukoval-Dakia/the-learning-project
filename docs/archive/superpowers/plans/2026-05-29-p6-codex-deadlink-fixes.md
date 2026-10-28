# Lane plan — P6 node-page dead-link fixes (Codex PR #193 review)

写于 fresh wave8 base `58a36457`，branch `fix/p6-codex-findings`。Refs YUK-96。

## 范围

修 Codex 在 PR #193 抓到的 3 个 P2 dead-link bug，全在 `/knowledge/[id]` 节点页读路径
（`src/server/knowledge/node-page.ts`）+ 渲染层（`app/(app)/knowledge/[id]/page.tsx`）。最小 diff，不扩范围。

## Bug 1 — 反链跳转用 artifact id 跳 learning-items 路由 → 404

### 查到的链
- `/learning-items/[id]` 路由按 **`learning_item.id`** 查（`app/api/learning-items/[id]/route.ts:100`
  `eq(learning_item.id, id)`），不接受 artifact id。
- artifact → owning learning_item 的唯一反向解路径是 `learning_item.primary_artifact_id == artifact.id`。
  1:1 设计（`docs/modules/learning-items.md:24`「hub ↔ note_hub 1:1; atomic ↔ note_atomic 1:1」）；
  生成流程 `learning_intent.ts:600-670` 里 hub/atomic/long 各自 `newId()` artifact 并设
  `primary_artifact_id` 指向它（learning_item.id ≠ artifact.id）。
- 因此从来源 artifact id 反查 `learning_item WHERE primary_artifact_id IN (sourceIds) AND archived_at IS NULL`
  得 `artifactId → learning_item_id` 映射。

### 选择
- `NodePageBacklink` 加 `from_learning_item_id: string | null`。
- backlink 聚合里对已通过 read-time 过滤的 source artifact ids 做一次 owning learning_item 查询建 map；
  解析得到 → 填 learning_item_id；解析不到（无 owning li 或 li archived）→ null。
- page.tsx：`from_learning_item_id` 非空时 wrap `<Link href=/learning-items/<li_id>>`；为空时渲染
  非链接（title + type badge，不 wrap Link）。绝不留 404 链接。

## Bug 2 — archived parent 未过滤 → dead link

- `node-page.ts:128-132` parent-name lookup 加 `and(eq(knowledge.id, parent_id), isNull(knowledge.archived_at))`
  → archived parent → parentName=null（page 已对 null parent_name fallback 到 parent_id，但更关键的是
  不该出 archived parent 的可点链接；改成 parent archived → parentName=null，且 page 渲染时若 parent
  endpoint 会 404 则不渲染链接）。
- 注意：page.tsx parent Row 用 `node.parent_id ? <Link>` 判定。Bug 2 单独看，parentName=null 仍会
  渲染 `<Link href=/knowledge/<archived parent_id>>{parent_id}</Link>` → 仍 404。所以 page.tsx 也要：
  parent_id 存在但 parent_name 为 null（= archived / 不可解析）→ 渲染非链接（显 parent_id 文本）。
- `resolveEffectiveDomain` 的 walk 不改（domain 继承穿 archived 不 404）。

## Bug 3 — archived mesh 邻居未过滤 → dead link

- `loadNames`(L322-328) 加 `isNull(knowledge.archived_at)` → 只返非 archived 名。
- mesh 构造（L151-168）：丢弃 name 不在 map 里的邻居（archived → 不在 map → skip），不要 id-fallback
  渲染。out / in 两个方向都过滤。

## 测试（扩 node-page.test.ts，强断言）

- archived parent → parent_name=null。
- archived mesh 邻居（out + in）→ 不出现在 mesh_neighbors。
- backlink 来源 artifact 有 owning learning_item → 解析出正确 from_learning_item_id。
- backlink 来源 artifact 无 owning learning_item（或 owning li archived）→ from_learning_item_id=null。

## gate

`pnpm typecheck && pnpm lint && pnpm audit:partition`
+ `pnpm vitest run --config vitest.db.config.ts src/server/knowledge/node-page.test.ts app/api/knowledge/[id]/route.test.ts`
+ `DATABASE_URL=postgres://x INTERNAL_TOKEN=x pnpm build`

## commit

`fix/p6-codex-findings`，message
`fix(P6): node-page dead-link fixes — backlink→learning_item id + archived parent/mesh filter (Codex #193 review)`，
body 逐 bug。结尾 `Refs YUK-96` + Co-Author。不 push、不 merge。
