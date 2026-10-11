# YUK-1404 公共 DNS — merge 交付证据

Branch `fix/yuk-1404-public-dns` · PR #1669 · 实施树
`/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1404-public-dns`。
服务审计根项：第一天能用（W0）YUK-1404 照片导入——容器继承宿主 fake-IP DNS
导致受守卫图片下载拒绝公网目的地。

## 已审基线与本轮范围

- 独立初审（GLM max，INITIAL）对上界 `da095572c0607c6f2d00bd7368112855a59ec0fc`
  （range `80e63a0..da095`）裁决 **NONE**，报告
  `/tmp/yuk1404-public-dns-initial-review-20261011.md`。
- 本轮只做与 `origin/main`（merge-base `80e63a0`，领先 22 个提交，作者 yuroro）的
  普通 merge。自有文件：`README.md`、`docker-compose.mac.yml`、
  `src/capabilities/ingestion/server/image-candidate-accept.ts`、
  `src/capabilities/ingestion/server/image-candidate-accept.unit.test.ts`、
  `vitest.shared.ts`、本文档。

## 实际冲突与解决

- 唯一冲突：`vitest.shared.ts` `fastTestInclude` 同一槽位。解决 = 双方新增条目
  并集、按路径序：`docx/route-classify.test.ts`（上游）+
  `image-candidate-accept.unit.test.ts`（本分支，第 38 行）。上游其余
  fastTestInclude/dbTestInclude 新增全部保留。
- `README.md` 自动合并：本分支「容器 DNS（YUK-1404）」节（:178）与上游文末
  「TEST home LAN access」节（:410）并存，无删减。
- `docker-compose.mac.yml`、`image-candidate-accept.ts` 及其单测与 da095
  **逐字节一致**（`git diff da095 -- <files>` 为空）。

## 对已审 da095 的语义 delta（全部）

1. `vitest.shared.ts`：+8 条上游测试条目（纯 additive；我方条目不动）。
2. `README.md`：+上游 LAN 访问节（文末；我方 DNS 节不动）。
3. 代码、单测、compose 三文件：无 delta。
上游触碰过我方错误消息的消费点 `ProposalCard.tsx`（剪贴板 LAN fallback），
与 `err.message` 展示路径无交集，merge 干净。
SSRF 守卫（`BLOCKED_IPV4_CIDRS` 198.18/15、逐跳重验、DNS 钉扎、上限）、
typed 错误契约、decision admission/stale 语义：均未动，上游亦未改相关文件。

## 本地 gate（Node 24.19.0，merge 后工作树）

- `pnpm vitest run --config vitest.unit.config.ts src/capabilities/ingestion/server/image-candidate-accept.unit.test.ts` → 8/8 passed（日志 `/tmp/yuk1404-unit-20261011.log`）。
- `pnpm exec biome check vitest.shared.ts` → clean。
- `pnpm typecheck` → exit 0（`/tmp/yuk1404-typecheck-20261011.log`）。
- `pnpm lint` → exit 0，172 条既存 warning（`/tmp/yuk1404-lint-20261011.log`）。
- `pnpm build` → exit 0（`/tmp/yuk1404-build-20261011.log`）。
未跑：full `pnpm test`、DB/docker/runtime/provider/deploy/sharedlock（按任务边界）。

## 不在本 PR 范围

jyeoo `/shiti` 页面 URL → 真实题图 resolver 接线是已批准的下一独立 slice；
无 hostproxy 配置、凭据或 provider 路由变更；`dns:` 仅加在 app/worker。

## 下一步（固定）

push 后 exact-head `CI Gate`；merge head 相对已审 da095 仅含上游并入 + 上述
additive delta，是否触发独立复审由 parent 裁决；merge 后按 README DNS 节执行
生产重建核对（`getent hosts www.jyeoo.com`）。

## Parent policy gate repair

Exact 314e43a69 run38136365309 policy failed on eight new security cases lacking per-case invariant annotations. Original public CI log is retained at `/tmp/yuk1404-pr1669-314e-policy-job.log`; parent reproduced the eight errors against fixed comparison SHA135bb18e6. Each assertion already rejects leaked source URLs, hosts or resolved addresses. Parent added `@invariant security` / precise `@fails-if` comments only. TypeScript's comment-free printer produces byte-identical executable test AST before and after; production DNS/download code stays identical to independently reviewed da095.

Parent audit now reports checked8/errors[] (`/tmp/yuk1404-pr1669-policy-annotations.log`), safety units8/8 (`/tmp/yuk1404-pr1669-policy-annotations-unit.log`), and typecheck/lint/build all exit0 (`/tmp/yuk1404-pr1669-policy-parent-gates.json`). No DB/runtime/provider or production changes. Original failure is not rerun away. New exact-head CI remains required before match-head merge.
