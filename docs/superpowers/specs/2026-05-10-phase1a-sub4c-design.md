# Phase 1a Sub 4C 设计 — Capture 流重整 + Tencent OCR Tier-1 + 退役 /record

> **Master spec**: `docs/superpowers/specs/2026-05-09-phase1a-design.md`（Phase 1a 整体）+ `docs/superpowers/specs/2026-05-10-phase1a-sub4a-design.md` § review_event 的 D1 batch 模式作类比参考
>
> **触发 review (2026-05-10)**：
> - 用户诊断：当前 `/record` 手敲为主、`/ingest` 拍图为辅 是把事情干反了。真实使用中（自用 + 文言文 + 试卷）题面本来就在书 / 纸上；强迫用户敲字增加阻力且失原图
> - 同时定下"Loom"工具名 + 字体栈（思源宋体 + Source Serif 4 + MiSans VF）+ 暖白 + coral accent 视觉锚 + Claude.ai aesthetic
> - 现有 OCR 路径只有 vision LLM（haiku 4.5）单层，cost / latency / 隐私三方面都不优。引入腾讯云 OCR 作 Tier 1 deterministic OCR，vision LLM 退到 Tier 2/3 兜底

**Goal**：1.5 天 / 1 PR。让"录题"成为唯一录入入口，永远从图开始。两层 OCR 级联（腾讯 + vision LLM）+ 一层手动兜底。退役 `/record` 路由 + UI；`/ingest` rename 为 `/capture` 并升格为主导航第一项。

---

## 一、范围 / 不在范围

| 在 | 不在（推 Phase 1b / 2 / 4D / Sub 5） |
|---|---|
| 删除 `/record` 客户端路由 + UI | POST `/api/mistakes` worker endpoint 是否同步删（lock 决策见 § 二） |
| `/ingest` → `/capture` rename（URL + UI 标题 + nav）| `/capture` 多模态 batch 优化（多图并发、跨页关联）— Phase 2 |
| Tencent OCR Tier 1 接通：教育试卷识别（首选）+ DocOCR（fallback） | Tencent OCR 自定义模板 / 公式识别 API（数学场景）— Phase 1b/2 |
| Vision LLM Tier 2 (haiku) + Tier 3 (sonnet) 自动级联 | BlockAssemblyTask AI auto-merge 跨页 — Phase 2（spec § Block Assembly B 路径）|
| Tier 4 手动 add block fallback（极端场景兜底） | OCR 结果可信度可视化（confidence heatmap 之类）— Phase 2 |
| `/capture` 审核页编辑能力提到一线公民（编辑 prompt_md / reference_md / wrong_answer / 任何字段；切分 / 合并；补救空 block） | Note Artifact 录入路径 — Phase 1b/2 |
| 主导航：📷 录题 → 📚 复习 → 📋 学习项 → 错题 / 知识 | 导航 redesign 整体（mobile bottom tabs + desktop sidebar）— UI design phase 整合 |
| design system 增量扩展原则（写进 PLANNING.md / 这份 spec） | 整套 design system 落地 — UI design phase（Sub 4D/4E 之类）|

---

## 二、关键决策（lock）

| 决策 | 选择 | 理由 |
|---|---|---|
| 录入入口收敛为单条 | 删除 /record，/ingest 升格为唯一入口 /capture | 手敲为主 + 拍图为辅在真实场景下颠倒；图本身就是源 |
| OCR Tier 1 实现 | **腾讯云教育试卷识别 API**（首选，对口学习场景结构化输出），DocOCR 通用文档识别（fallback —— 非试卷图） | 跟 question_block.role / page_spans schema 直接对口；2024-25 中文 doc OCR 第一梯队 |
| OCR 鉴权 | TC3-HMAC-SHA256，Worker 内用 `fetch` + `crypto.subtle` 自实现签名（不引 Node SDK，CF Workers 跑不了 `@tencentcloud/cloud-sdk`）；secrets `TENCENT_SECRET_ID` + `TENCENT_SECRET_KEY` 走 `wrangler secret put` | 标准 Tencent 鉴权协议 + Workers 兼容 |
| Tier 2/3 vision LLM | Tier 2 = haiku 4.5（已有 VisionExtractTask）；Tier 3 = sonnet 4.6（新增 VisionExtractTaskHeavy registry 项） | 失败成本极小：均价仍是 Tier 1，仅 Tier 1 0 region 时升级 |
| 级联触发条件 | Tier 1 0 regions OR 全 region confidence < 0.6 → Tier 2；Tier 2 0 blocks → Tier 3；Tier 3 0 blocks → 用户审核页手动 add block | 阈值后期可调；MVP 用 0.6 |
| 失败签名 / 元信息 | 每次升级在 ingestion_session.error_message JSON 累计 `tier_log: [{tier, model, blocks_count, took_ms, reason}]` | 留 audit；Sub 5 export 时可分析失败模式 |
| /capture 审核页编辑能力 | 每个 block 全字段可编辑（prompt_md / reference_md / wrong_answer / role / image_refs） + 拆分 / 合并 / 删除 / 新增空 block | 当 OCR 不准（这是常态）时用户能彻底修复，不被 OCR 输出形态束缚 |
| POST /api/mistakes endpoint | **保留**作私有 fallback，不挂 UI 入口；标 internal | 0 工程成本（保留路由 + 测试）；未来程序化导入（CLI / API integration）能用；Phase 2 Maintenance 路径可能要 |
| 主导航 | 第一项 📷 **录题** /capture；其他位置 (/review, /learning-items, /mistakes) 保留；/record 删除 | 物理简化：减少认知开销 |
| OCR 异步 vs 同步 | 同步（与 vision LLM 一致）；同 500ms-2s 范围 | 用户期望"上传 → 等等 → 看结果"；不引入 polling |
| OCR 调用结构 | `workers/src/ingestion/ocr_tencent.ts` thin wrapper：`recognizeDocument(imageBytes, mimeType): Promise<TencentOCRResult>`；normalize 到既有 `VisionBlock` 形态 | 保持 ingestion 主路径 schema 不变 |

---

## 三、Server 设计

### 3.1 OCR Tier cascade

新文件 `workers/src/ingestion/ocr_tencent.ts`：

```ts
interface TencentOCRRegion {
  bbox: { x: number; y: number; width: number; height: number };  // 归一化 [0,1]
  text: string;
  type: 'text' | 'table' | 'figure' | 'unknown';  // 试卷场景下也含 'question' / 'answer'
  confidence: number;  // 0-1
  page_index: number;  // injected by caller
}

interface TencentOCRResult {
  regions: TencentOCRRegion[];
  raw_response?: unknown;  // for debugging / Sub 5 export
}

async function recognizeDocument(
  imageBytes: ArrayBuffer,
  mimeType: string,
  pageIndex: number,
  env: { TENCENT_SECRET_ID: string; TENCENT_SECRET_KEY: string },
): Promise<TencentOCRResult>;
```

实现要点：
- TC3-HMAC-SHA256 签名：CF Workers 没有 Node 运行时，无法用 `@tencentcloud/cloud-sdk`；按 Tencent 官方 TC3 文档手写签名，全用 `fetch` + `crypto.subtle.digest('SHA-256', ...)` + `crypto.subtle.importKey + sign('HMAC', ...)`。签名步骤拆成纯函数，单测 mock 时间戳后断签名字符串
- 端点优先：`POST https://ocr.tencentcloudapi.com/?Action=EduPaperOCR`（教育试卷）→ fallback `Action=DocOCR`（通用文档）
- 输出归一化：bbox 像素 → 0-1 归一（除以 image dimensions）；type 字符串映射到 question_block role enum

**runOCRCascade**（替代当前 vision-only 路径）：

```ts
type Tier = 1 | 2 | 3 | 4;

interface CascadeResult {
  blocks: NormalizedBlock[];  // 同 question_block 形态
  tier_log: Array<{
    tier: Tier;
    model: string;
    blocks_count: number;
    confidence_avg: number | null;
    took_ms: number;
    reason?: string;
  }>;
  final_status: 'extracted' | 'failed';
}

async function runOCRCascade(params: {
  imageBytes: ArrayBuffer;
  mimeType: string;
  pageIndex: number;
  env: AppEnv['Bindings'];
  runTaskFn: RunTaskFn;
}): Promise<CascadeResult>;
```

升级规则：
- Tier 1 (Tencent) returned ≥1 region AND avg confidence ≥ 0.6 → return
- Tier 1 0 regions OR avg confidence < 0.6 → Tier 2 (haiku)
- Tier 2 0 blocks → Tier 3 (sonnet)
- Tier 3 0 blocks → final_status = 'failed', blocks=[], tier_log 完整记录所有尝试
- 任何 tier 抛错（非 0-result，是真异常）→ 记 reason，继续下一 tier

每 tier 的 took_ms / blocks_count / confidence_avg 全记 tier_log → 写入 `ingestion_session.error_message`（即使 status=extracted 也写——名称应该叫 `tier_log` 但 schema 已 ship `error_message`，重用即可，JSON 内容自描述）。

### 3.2 修改 `workers/src/routes/ingestion.ts`

替换 per-asset loop 内的 `runVisionExtract(...)` 直接调用 → `runOCRCascade(...)`。其余流程（INSERT question_block / 返回 blocks / session.status）保持不变。

新增 registry 项 `VisionExtractTaskHeavy`（src/ai/registry.ts）：
- 跟 VisionExtractTask 同 system prompt + multimodal: true
- defaultModel: `'claude-sonnet-4-6'`
- 仅在 Tier 3 cascade 时调用

### 3.3 配置

`workers/wrangler.toml` 新增 secrets（不写明文，部署时 `wrangler secret put`）：
```
TENCENT_SECRET_ID
TENCENT_SECRET_KEY
TENCENT_OCR_REGION = "ap-guangzhou"  # 或 ap-hongkong（CF Worker 延迟更低）
```

`workers/src/types.ts` `Bindings` 新增 3 个字符串字段。

---

## 四、Client 设计

### 4.1 删除 /record

- 删除 `src/routes/record.tsx` 整个文件
- 删除 `src/App.tsx` 内 `/record` 路由 + import
- 更新 `src/routes/inspect.tsx` admin 链接列表（去掉 /record，加 /capture）

### 4.2 /ingest → /capture rename

- 文件名：`src/routes/ingest.tsx` → `src/routes/capture.tsx`
- 组件名：`IngestSession` → `CaptureSession`
- 路由：`<Route path="/ingest" .../>` → `<Route path="/capture" .../>`
- 重定向：保留 `/ingest` 路由 30 天，重定向到 `/capture`，避免外链 / 书签断（`<Route path="/ingest" element={<Navigate to="/capture" replace />} />`）
- UI 标题："录入" → "录题"
- 文案中所有 "ingest" 替换为 "capture" / "录题"

### 4.3 审核页加强

每张 block card 新增：
- **inline 编辑全字段**：title (extracted_prompt_md) / reference_md / wrong_answer_md / knowledge_ids / cause / difficulty / question_kind 全部 inline；保存按钮 OR blur 自动保存（先 blur 自动）
- **role select**：page_spans[0].role 用户可改（'prompt' / 'answer_area' / 'continuation'）
- **删除 block 按钮**（× 角落 / "丢弃此 block"）
- **拆分 block 按钮**（已有）+ **合并 block 按钮**（已有）
- **新增**：顶部"+ 手动添加空 block"按钮 → 创建 client 端虚拟 block（`block_id: undefined`, `source_block_ids: []`），用户全填字段后随其他 blocks 一起 import

### 4.4 主导航更新

整个项目还没有真正的主 nav（只有 `/_/inspect` admin 链接）。Sub 4C 不引入完整 nav redesign（那是 UI design phase 的事），但要：
- `src/routes/index.tsx` Home 页加 4 个一级入口卡：📷 录题（/capture，主推）/ 📚 复习（/review）/ 📋 学习项（/learning-items）/ 历史（/mistakes）
- `/record` 入口移除（已删）
- mobile-friendly：grid-cols-2 on mobile, grid-cols-4 on desktop

### 4.5 文件 / 模块边界

| 路径 | 责任 | 新建 / 修改 / 删除 |
|---|---|---|
| `workers/wrangler.toml` | + Tencent secrets / region 配置位 | 改 |
| `workers/src/types.ts` | + `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY` / `TENCENT_OCR_REGION` Bindings | 改 |
| `workers/src/ingestion/ocr_tencent.ts` | TC3-HMAC 签名 + EduPaperOCR / DocOCR endpoint + normalize | 新 |
| `workers/src/ingestion/ocr_tencent.test.ts` | mock Tencent response + signature 计算 + normalize 测试 | 新 |
| `workers/src/ingestion/cascade.ts` | runOCRCascade 编排 4 层 | 新 |
| `workers/src/ingestion/cascade.test.ts` | 各 tier 触发条件 / tier_log 累计 / failure mode | 新 |
| `workers/src/routes/ingestion.ts` | 替换 runVisionExtract 直调 → runOCRCascade；session.error_message 写入 tier_log | 改 |
| `workers/src/routes/ingestion.test.ts` | mockEnv 加 TENCENT_* / runTaskFn 多次调用模拟 cascade | 改 |
| `src/ai/registry.ts` | + `VisionExtractTaskHeavy`（sonnet） | 改 |
| `src/routes/record.tsx` | 删除整个文件 | 删 |
| `src/routes/ingest.tsx` → `capture.tsx` | rename + 审核页编辑能力加强 + 手动 add block | 改 + rename |
| `src/App.tsx` | 删 /record 路由 + import；改 /ingest → /capture（含 redirect） | 改 |
| `src/routes/inspect.tsx` | nav 链接更新 | 改 |
| `src/routes/index.tsx` | 4 个一级入口卡 | 改 |
| `PLANNING.md` | 标 Sub 4C 完成；标 design system 增量扩展原则 | 改 |

---

## 五、约束 / 不变量

- **录入唯一入口**：用户必须经过 /capture 才能创建 mistake。POST /api/mistakes endpoint 内部仍可被调用（程序化导入），但 UI 不暴露
- **OCR cascade 是 deterministic + 单调升级**：每个 tier 仅在前 tier 真正失败（0 results）时触发；不会跳级；不会回退
- **tier_log append-only**：在同一 ingestion_session 的多次重试不会重置 tier_log（如果用户对同一 session 重新调 OCR，要新建 session）
- **OCR API 可用性外部依赖**：Tencent endpoint 不可达 → Tier 1 fail，自动降级 Tier 2；不影响整体流程
- **secrets 不入 git**：`TENCENT_SECRET_ID` / `_KEY` 通过 `wrangler secret put` 配置；wrangler.toml 仅声明位置
- **/record 退役无回头**：删了就删了；写进 spec / commit message，便于 audit
- **审核页编辑彻底化**：用户应能在审核页完成所有 mistake 字段填写，OCR 不准时不被流程卡住
- **design system 增量扩展原则**（新加，全 sub 都遵循）：每加一个新 module（Note / Quiz / Orchestrator UI 等），扩展 design tokens 而非重写；新 component 入 `src/components/`；不破坏既有 token 名

---

## 六、估时 / PR

| 段 | 任务 | 估时 |
|---|---|---|
| OCR layer | ocr_tencent.ts（签名 + endpoint）+ test ~6 个 / cascade.ts + test ~5 个 | ~0.6d |
| Route 整合 | ingestion.ts 替换调用 / registry sonnet 新项 / Bindings 加字段 | ~0.2d |
| Client 删 / rename | record.tsx 删；ingest → capture rename；redirect；nav 文案；测试 regression | ~0.2d |
| 审核页加强 | inline 编辑全字段 + role select + 删 / 添加空 block 按钮 | ~0.4d |
| Home 4 入口 + inspect 更新 | index.tsx 4 卡 / inspect.tsx 链接 | ~0.1d |
| 整合验证 | typecheck / build / 手动 smoke 跑一遍真录入 | — |
| **合计** | | **~1.5d** |

**1 个 PR**：`feat(capture): Phase 1a Sub 4C — OCR cascade + /record 退役 + /capture 升格`

---

## 七、Open（实施时再决）

1. **Tencent OCR endpoint 优先级**：教育试卷识别 OR DocOCR 哪个 first？两个都试 → 选 confidence 高的？还是教育试卷 first，0 region 才 DocOCR？(MVP 推后者，避免双倍成本)
2. **OCR 区域映射**：Tencent 输出 region.type 是否所有值都能映射到我们 question_block role？如果出现 'table' / 'formula' 等未知 type，role 取 'prompt' 默认还是新增 enum 值？
3. **CF Worker 调 Tencent**：Tencent 香港节点 vs 广州节点延迟实测；如果广州慢于 200ms，切香港；secret 配置时 region 一并填
4. **混合图像优先级**：一张图同时含印刷题 + 手写错答 → Tencent 教育试卷识别 SDK 应该能区分（输出 question / answer regions），但要实测；若不能，加 Tier 1.5 = Tencent 通用 OCR（印刷 + 手写一起）
5. **Image 大小限制**：Tencent OCR 支持 ≤7MB / ≤4096x4096；超过要客户端 resize 或服务端拒绝。当前 /api/assets 上限 8MB 一致
6. **Migration script**：现有 mistake 行有 metadata.prompt_image_refs（来自 PR A 后的 base64 → R2 迁移），4C 不动这部分；4C 仅影响新录入路径
7. **/api/ingestion 旧 client 兼容**：`/ingest` 路径会 30 天后删？还是永久 redirect？（建议永久 redirect，避免外链断）
8. **i18n / 文案微调**：审核页"提取出 N 题"等文案审稿；mobile UI 优化推 UI design phase

---

## 八、设计 system 增量扩展原则（lock 进 PLANNING）

每加一个新 module / page / 重大功能，必须：

1. **扩展，不重写**：在 `src/index.css` 既有 `--token-*` 之上加新 token；不要替换已有名字
2. **抽 component 而非散写**：发现重复模式（出现 ≥3 次）→ 抽到 `src/components/`；命名按 `Card` / `StatusBadge` / `KnowledgePicker` 业务名而非 `BoxV2`
3. **写 design extension 小文档**：每个大 sub 完成时，如果引入新 component / 新 token，加一节到 `docs/design/extensions.md`：[新增 token + 用途] / [新增 component + 用途 + 已用页]。
4. **不偏离 Loom anchor**：暖白底 + coral 单 accent / 思源宋体 + Source Serif 4 + MiSans + Inter / 中文优先 / 低视觉噪音 / 无 emoji / 无游戏化。所有新 sub 输出回看一眼是否漂移
5. **既有 page 用既有 token**：不允许新 page 用 ad-hoc 颜色 / 字号 / 间距；如果 token 不够用 → 先扩展 token，再用
