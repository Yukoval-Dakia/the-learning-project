# YUK-1476 — DOCX header/footer（及 body）外部资源关系：转换器输入副本安全省略

日期：2026-10-11 · lane：`fix/yuk-1476-docx-external-header-footer`（bfe3ff984 切出）
状态：domain + invariant 测试已交付；canonical adapter（`src/capabilities/ingestion/api/docx.ts`）
等待 migration 最小 release 后由 parent 中继 handoff 再接线。

## 问题（真实证据）

学校政治卷 DOCX（raw SHA `6b7e5…`，封存于仓库外 `tlp-status/review/real-pipeline-zj-papers/docx-import-offline-03`）
POST `/api/ingestion/docx` → 400
`{error:'validation_error', message:'DOCX 包含外部资源关系（word/_rels/footer1.xml.rels）；…'}`。
`word/_rels/footer1.xml.rels`：rId1 内部图片，rId2 `TargetMode="External"` 图片（非 hyperlink）。
全 0 delta：question/session/assets/block 均未建。测量保持封存失败，未原地修补。

## Owner 语义（2026-10-11 纠正，覆盖早期 body 拒绝方案）

1. header/footer 外部关系**安全忽略**；body 外部关系**同规则安全忽略**——非内容不得导致整文件拒绝。
2. **NEVER fetch/embed** 外部资源；原外部 target 绝不进入 Pandoc/LibreOffice。
3. 真实 body 内嵌图（31/32 题干图，internal rels）必须原样保留。
4. 真正无法导入的内容逐题诚实上报 unknown/omitted，不编造、不整批失败。
5. Import receipt learner wording 固定「已忽略外部链接」；原件/copy digest/audit 保留。
6. 现有异常 XML / zipbomb / 路径 / 授权 guard 继续；不放行外部 fetch。

## 设计（`route-classify.ts`）

- `classifyDocx(bytes): DocxLine` **行为不变**，仍是 adapter 未释放前的 fail-closed 闸
  （放宽它 = 把带外部 target 的原件交给转换器）。
- 新增 `prepareDocxForConversion(bytes): DocxConversionPrep`：
  - **Pass 1**（与 classify 共享 `scanForClassification`）：只解压 document XML + rels parts，
    沿用既有 count/size/duplicate/DOCTYPE/entity/XML 校验；计算 MathType 路由。
  - DOCTYPE rels part → 拒绝（实体攻击不搭省略便车）。hyperlink 类外部关系 → 保留（惰性元数据）。
  - 其余外部非 hyperlink 关系（任意 rels part，含 body）→ 从**转换器输入副本**移除该
    `<Relationship>` 元素。
  - **Pass 2**（仅当需省略）：`unzipSync` 全量但**累计解压上限 200MB 在膨胀前检查**
    （`originalSize` 预膨胀可见，同 pass-1 防炸弹技术扩展到全量）→ 改写命中的 rels parts →
    `zipSync` 固定 mtime(1980-01-01) 重建 → **后置断言**：对副本重跑 pass-1 扫描，
    任何外部非 hyperlink 残留即 400。这是运行时强制的 never-fetched 不变量，非仅靠测试。
- 序列化器：扁平 OPC schema 确定性重写（UTF-8 固定 prolog；属性值全量转义；
  round-trip 重校验：重 validate + 重 parse + kept 属性逐一相等 + 0 外部残留）。
  无法忠实重写的形状 → 拒绝（绝不绕过）。UTF-16 rels part → 副本中重写为自洽 UTF-8。
- 最小充分 fflate 支持：仅 `unzipSync(filter)` + `zipSync`（已有依赖 v0.8.3），无自定义 ZIP parser。
- `DocxConversionPrep = { line, converterBytes, omissions[], inputSha256, converterInputSha256 }`。
  无省略时 `converterBytes` 即原字节（同引用零拷贝）；omission 事实只含 part/rId/公开 Type 类别，
  **绝不含外部 Target URL**。

## 审计（`docx-ingestion.ts`，text line）

- `InitiateDocxTextUploadParams.externalRefOmission?: { inputSha256, converterInputSha256, omissions }`
  （仅在发生省略时传）。
- `source_document.provenance` 增 `docx_external_ref_omission`（双 digest + omitted 事实 +
  learner_notice）——复用既有 JSON 列，无新 schema/table。
- `learning_session.warnings` + `ingestion.extraction_completed` payload + session event payload
  携带「已忽略外部链接」——warnings 本就是 session-detail DTO 既有字段，无新文案面。

## Adapter 接线（2026-10-11 release 后已落地）

`api/docx.ts` 已切换到 `prepareDocxForConversion`：visual/text 两线的
`persistDocxPageEvidence` 与 `docxToMarkdown` 均只接 `prep.converterBytes`；
text line 额外携带 `externalRefOmission`（仅 omissions 非空时）。响应/Location/
错误契约不变。原 `classifyDocx` 随之移除（无消费者，避免并行导入路径）；
其守卫行为全部由 `prepareDocxForConversion` 内部保留（DOCTYPE/实体/XML/
duplicate/bounds/missing-document 仍 reject，外部非 hyperlink 从 reject 改为
省略——owner 语义）。

## 测试（`route-classify.test.ts`，unit，已登记 fastTestInclude）

安全/数据保全不变量 15 例全绿：classify 闸保持（真实失败形状仍 400）、footer/body 同规则省略、
31/32 形状内嵌图字节级保留、hyperlink 保留、MathType 路由并存、干净文件恒等快路径、
确定性重建、UTF-16 part、DOCTYPE/entity/duplicate/missing/non-zip fail-closed、
序列化不可能形状拒绝、210MB→200KB 高比率档案在解压上限前拒绝（无外部关系时不误伤）。

## 限制与诚实边界

- **visual line 的 omission 审计未持久化**：visual 线走通用 `Ingestion.initiateUpload`
  （非本 lane 所有的 `docx-ingestion.ts`）；已接线的是字节层（转换器只见副本），
  provenance 届时需扩展 initiateUpload 参数——留给 parent 决定。
- **逐题 omission 映射不可得**：pandoc media manifest 对 dangling 引用不产生条目，
  无法把被省略的外部图定位到具体题号；本轮交付文档级 omission 审计（part/rId/类型/计数）。
  题级映射需 body XML rId→blip 位置分析，超出本 bounded lane。
- 本 lane 无法跑真实 pandoc/LibreOffice（本机无 binary；docker/DB/container 被 parent 禁用），
  31/32 保留证据 = 结构不变量（副本内 media/rels 字节等同）+ 既有 text branch 代码路径
  （`api/docx.ts:94-137` pandoc --extract-media → persistImageAsset → blocks.imageRefs）；
  真实转换器验收归 parent 修复后实际入口 run。
- 剩余 fail-closed 拒绝的 typed `details.reason` 固定签名（仅提案，未实施，owner 已裁不写 DTO）：
  `details: { reason: 'docx_external_resource_relationship', part: <rels part name> }`。
