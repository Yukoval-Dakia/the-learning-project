# 终局 drift 审计（YUK-321 M5 Task 10）

> 日期：2026-06-13（文件名沿 plan 指定）。范围：M5 旧栈拆除后的 ADR / planning-doc ↔ 代码
> 结构性漂移终局扫描（/audit-drift；不重审 schema 字段——那是 `pnpm audit:schema` 的领地）。
> 方法：三路并行勘察（ADR 全集 / 入口文档反向核查 / 近 30 天活跃 plans+design），勘察结论
> 经主会话 grep / Read 逐条复核后才入本报告。

## Summary

| 分类 | 计数 | 处置 |
|---|---|---|
| Aligned | 8 | 不展开（含 ADR-0014、M0 组合根、M5 copilotTools 五条、Evidence-first 路径 `src/server/ai/log.ts`、8 capability 包结构、editing_presence 子计划↔实现） |
| Contradicted | 1 | F1，已当场修 |
| Undocumented | 1 组（7 文件） | F2，已当场修 |
| Documented-only | 0 | — |
| 设计稿被部分推翻 | 1 组（2 文件） | F3，已当场修 |
| Phase-deferred | 1 | 不报（`docs/design/2026-06-13-memory-architecture.md`，独立 PR 待发，未进实现期） |
| 勘察假阳性（剔除） | 1 | 见「核查记录」 |

M5 范围内漂移全部当场修毕；范围外两条弱漂移归「遗留」节供 Linear capture 裁决。

## Findings

### F1 — ADR-0023 共享后端决策被 M5 推翻未标注（Contradicted，已修）

ADR-0023 通篇以 Redis（redis:7-alpine / REDIS_URL / ioredis / Lua 原子段 / YUK-171 fail-safe
降级）为决策本体；M5 Task 9（gate 选项 b）已把共享后端换成 PG 表 `editing_presence`
（`PgPresenceStore`），Redis 三件全删。**修法**：头部 `Superseded by:` 标注部分迁移 + 文末
新增「M5 迁移注」小节——逐条划清继续成立（PresenceStore 抽象、跨进程共享、决策原子 IO 在外、
ephemeral 陈旧 pending 丢弃语义）与不再成立（Redis 容器 / REDIS_URL / ioredis fail-safe
降级——PG 即业务库直接抛错）+ 路由迁移指向。

### F2 — 7 个 ADR 的 app/api 路径 rot（Undocumented，已修）

`grep -l 'app/api' docs/adr/*.md` 实测命中 0013 / 0019 / 0021 / 0024 / 0025 / 0028 / 0030
（+0023 由 F1 单修）。这些 ADR 的决策本身不受 M5 影响，但文中 `app/api/**` Next route 路径
已不存在。**修法**：7 文件文末统一追加 M5 路径注（路径迁移至 capability manifests +
`server/app.ts` 组合根；决策本身不受影响）。勘察报告原命中清单不准（漏 0024/0025、多 0011），
按主会话实测清单修，0011 无字面命中不加注。

### F3 — 两份 2026-06-09 copilot design doc 状态过期（已修）

- `2026-06-09-copilot-presentation-layer.md`（SETTLED）：Copilot 收口已落地为
  `src/capabilities/copilot/`，但「唯二新建」（interactive artifact ADR-0033、async tracker
  P3）未随 M5 落地。**修法**：头部 M5 后注，标注落地面与 future work 分界。
- `2026-06-09-mcp-tool-design-review.md`（CRYSTALLIZED→ADR-0032）：§1.1 基线 `bootstrap.ts`
  CORE_TOOLS 清单已随旧栈退役，工具面改 copilotTools 贡献制。**修法**：头部 M5 后注，
  保留决策账本地位。

## 遗留（M5 范围外，供 Linear capture 裁决）

1. **FSRS 单元粒度双路径过渡态**（弱）：知识点粒度调度与 legacy learning_item 粒度路径并存，
   schema 注释已自我声明 legacy fallback——属声明过的过渡态而非未声明漂移，低优先级。
2. **`learning_item.primary_artifact_id` 指针保留**（弱/可能不立项）：「松绑 1:1 不变量」
   字面已兑现（uniqueIndex 已 drop），字段保留为 nullable pointer 与声明不矛盾；仅指针与
   `knowledge_ids` 引用并存可能引起后续读者困惑。

## 核查记录

- **勘误（M5 全分支 review H2，2026-06-13）**：Summary 表「editing_presence 子计划↔实现
  Aligned」当时漏判——T5c 拆除 ArtifactBlockTree 时把 heartbeat/blur 的**唯一前端调用方**
  一并拆掉，新基建（PG 表 + PgPresenceStore）读侧活、写侧零调用点：恒 idle ⇒ AI patch
  永即时 apply，ADR-0023 编辑期 defer 不变量实际失效。已于 review-fix commit 在 SPA
  NoteReaderPage 编辑态接线 heartbeat（5s）/blur（等价旧契约），Aligned 判定自此成立。
- **假阳性剔除**：drift-plans 勘察称 `practice_stream_item` 表缺失——主会话核验该表在
  `src/db/schema.ts:823-851` 完整存在（含两索引），剔除。
- **drift-entry 反向核查 11/11 PASS**：Task 10 五件入口文档改写（README / CLAUDE.md /
  docs/architecture.md / postman/README.md / status.md）的全部事实性断言（端口、进程拓扑、
  build 产物、compose 形态、manifest 对账层）逐条对代码复核通过。
- 残留 grep 复跑（`next dev|next build|:3000|Redis|ioredis|app/api` 排除历史语境）零非历史
  命中；`pnpm audit:schema` 257 字段 unallowed 0。
