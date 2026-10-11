# YUK-1358 — stream typed operation extraction

日期：2026-10-11。行为保留抽取（behavior-preserving extraction），不改任何 wire/语义。

## 动机

`api/stream.ts` 的 GET/POST/PATCH 内联了校验、日期裁定、seed 派生与 rate-limit。
TanStack Start 的 `/practice` live consumer 需要不经 Request/Response 复用同一组
编排——抽成 `server/stream-operations.ts` 的 typed operations，HTTP 文件降为适配层。

## 公开签名（`server/stream-operations.ts`）

```ts
getPracticeStream(database: Db, rawQuery: unknown): Promise<StreamView>
recomposePracticeStream(database: Db, rawBody: unknown): Promise<PracticeStreamRecomposeResult>
updatePracticeStreamItem(database: Db, itemId: string, rawBody: unknown): Promise<PracticeStreamUpdatedItem>
```

- `rawQuery`/`rawBody` 收未校验输入，operation 内 `safeParse`（runtime schema 是校验权威，
  第二 consumer 不重复策略）。
- `PracticeStreamRecomposeResult = StreamView & { added }`；
  `PracticeStreamUpdatedItem.item = Omit<StreamItemRow, keyof ViewItem> & ViewItem`
  （即 `{ ...row, ...viewItem }` 的精确覆写语义）。
- `resolveDate` 私有保留：`'today'`/缺省/`''` → `streamLocalDate()`；其他先过
  `PracticeStreamCalendarDateSchema`，非法 → `invalid date: <raw>` 400。

## 行为不变量（逐条对照原实现）

- GET：query `safeParse` 失败 → `invalid query parameters` 400；`knowledgeId` 无条件透传；
  `composeIfEmpty`/`materializeScoped`/`composeDeps` 仅 `date === streamLocalDate()`；
  compose seed triggerId = date；`providerInvocation`（db/caller api/65s deadline/
  operationAnchor=newId）不变。
- POST：调用方 `req.json().catch(() => ({}))`（PATCH 是 `null`）；body safeParse →
  `invalid body` 400 → resolveDate → `checkRateLimit()` → `newId()` nonce →
  `recomposeStream` → `getStream(enforceBudget: true)` → `{ added, ...view }`。
- PATCH：body safeParse → status 枚举 400 → `advanceStreamItem`（rerank seed =
  `(streamLocalDate(), 'rerank', itemId)`）→ null → `not_found` 404 →
  `getStreamViewItem` → `{ item: { ...row, ...viewItem } }`。

## 导出面

`practice/public.ts` 以 lazy wrapper 透出三操作 + `export type` 透出结果类型——
stream-store compose 链可达 AI runner SDK，与 `submitReviewAnswer` 同款纪律，
不静态进入 barrel 的 migrate-bundle 消费面。

## 验证

`pnpm typecheck`（双 tsconfig）✓；`biome check` 触及文件零诊断 ✓；`pnpm build`
（web+start+server+worker+migrate）✓；`pnpm gen:postman` 再生成后 `postman/` 零 diff
——wire 契约逐字节不变。DB/runtime 行为由既有 `api/stream.db.test.ts` 在父 lane 复核。
