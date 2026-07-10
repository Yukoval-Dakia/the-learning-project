# YUK-597 — 科目手填（自定义科目）+ SubjectProfile DB 化：设计终稿

2026-07-10 · 对抗面板综合（run `wf_eef6dfd1-94a`：2 侦察席 + 3 设计席 LIGHT/FULL/SUBSTRATE + 3 对抗席 + Fable 综合席）。
**Owner 判词（2026-07-10）：D1 = 臂 B（subject_profile 入 DB 全案）· D2 = opaque id `subj_<cuid2>`。**
本 doc 是实施单（YUK-598~602）的权威依据；draft 原文与 blast-radius 细表见 Linear YUK-597 评论 + 面板六稿。

---

## 1. 面板裁决：原 LIGHT/FULL 是假分叉

- **KILL-1（LIGHT 案证伪，主线复核）**：「科目=派生视角」（2026-06-07/08 裁决）的唯一代码实现 `resolveSubjectKnowledgeIds` 的判据是 `src/capabilities/knowledge/server/domain.ts:105` `resolveKnownSubjectId(domain) === subject` —— 纯内存 registry 自别名查表（`src/subjects/profile.ts:111` 注册时 `aliases.set(id,id)`；`:143-153` miss→null）。未注册 custom id 恒 null → 按科筛题空（questions-list.ts:99）、AI subjectId 合同空（query-questions.ts:65，违裁决第 4 条）、goal scope 派生空且上传后不长；仅 placement 靠 tier-3 全树兜底存活。**「纯 domain 字符串零注册」结构性死。**
- **F1/F3（FULL 案修形）**：`seedKnowledge`（seed.ts:26-30）循环编译期常量，结构上不能为运行时 id 建根 → 创建路径必须自己 INSERT 根 → **seed root 即科目在知识树上的存在锚**；admin 全字段编辑器的 live consumer 是 owner 低频操作，可选层默认后置（§4 PR7）。
- **AMEND-1（SUBSTRATE 对抗席，主线复核 triggers.ts:478）**：L1 scope_key slug/RAW 分歧是 cosmetic 死代码——live brief 再生走 `loadSubjectBriefEvents`，affected_scopes JOIN 已显式弃用（active-subjects.ts:9-13）；opaque id 为 ASCII 后 `slug(id)===id` 恒真，分歧从根消失，仍统一三调用点 + 回归测试。

## 2. 判词后的定案架构

**代码 4 profile 降级为 bootstrap 种子 + 断网兜底；DB 表 `subject_profile` 为运行时真相源；两进程（app/worker）启动两相加载：同步代码种子构造 registry → 异步 `hydrateFromDb` 覆盖同 id、追加新 id（register-with-replace `upsert()`，复用 `validateProfile`）。`KNOWN_SUBJECT_IDS` 拆两层：编译期 builtin 集（类型/测试）+ 运行时 `getKnownSubjectIds()`（registry 派生）。**

- **id**：`subj_<cuid2>`，复用 `newId`（src/core/ids.ts），**不可变**（admin 禁改 id，只改 displayName）；displayName 独立承载人类串。rename 免迁移（YUK-249 整条 lane 是 id=名字耦合的代价实证）。
- **表**：hybrid——扁平审计列（id/display_name/version/origin/judge_capabilities/scheduling_policy/is_active/时间戳）+ `definition jsonb $type<SubjectProfile>` 全量已校验载荷（唯一真相，扁平列是派生投影）。从表 `subject_profile_alias(alias PK, subject_id FK)` 承接 wenyan→yuwen 等降级别名。
- **precedence**：DB wins for same id；种子迁移幂等 `ON CONFLICT DO NOTHING`；admin 提供 reset-to-default（用代码种子重写）。退化链：无表/无行 → 纯代码 4 profile，与今日行为逐位一致（地基 PR 零行为变化可先合）。
- **写门**：`POST/PUT /api/admin/subjects` 在写前跑 `validateProfile`（与 register()/audit:profile 逐字同函数），fail → 422 + issue 列表回显；写路径绝不绕 gate 直插表。挂全站 `x-internal-token`，不新增 auth。
- **建科目即建根**：`ensureSubjectRoot(db, subjectId, displayName)`（自 seed.ts:36-54 重构，root `name`=displayName、`domain`=subjectId），创建路由调用 + `insertGoal` 单一写面幂等兜底（防 manual/proposal 两条 goal 路径漏根）；goal-create Body 加 optional `subjectDisplayName` passthrough。
- **UI 双面**：onboarding `/welcome` 自由文本 **thin-create**（displayName 覆盖 + 其余字段 clone general——Zod `.min(1)` 决定 thin 不能真 thin）→ general 泛化人格 + 「通用模式」badge（`isGeneralFallback`）；admin `/admin/subjects` 只读→全字段 CRUD（校验 badge + reset-to-default）。copilot 建科目工具**不建**（无 consumer）。
- **fan-out gate 而非全量 repoint**：`goal_scope_propose_nightly.ts:113` 仅纳入 ≥5 KC 的 custom 科目（防每晚空烧 LLM，阈值可调）；bridge 词表三处默认回退点（auto-enroll.ts:502 / image-candidate-accept.ts:647 / tag-knowledge.ts:173,265）逐点审计注入（closed-set 分类器稀释风险），并 `grep KNOWN_SUBJECT_IDS` 穷举残留 caller。
- **漂移治理**：`pnpm audit:profile --db` 模式逐行 `validateProfile` DB profiles（report-only）+ 夜间 cron `--strict`（复用 sweeper 基建）+ admin 行内校验 badge。每次 save bump `version`；revision 快照历史表 = PR7 内可选层，实施时裁。
- **加载一致性（工程默认，可调）**：boot 水合 + app 写时 in-process `upsert`；worker 对 registry miss 做一次 lazy DB re-check（新科目免重启可见）；**编辑既有 profile** worker 侧重启生效（admin 提示「保存后重启 worker」）；LISTEN/NOTIFY 热加载不做（单用户低频，建成不通电嫌疑）。
- **既定降级拥抱**：custom 科目色板落 neutral 灰（不扩 renderConfig）；无 per-subject skills 目录 = 优雅降级 promptFragments（runner.ts never-throws，Dockerfile 不加 COPY）；mastery family_key 随注册修复自动获得真 subject 段。

## 3. 裁决合规自查

全局一图 ✓（无 per-subject 树契约）· 科目=派生视角 ✓（仍走 effective_domain 轴，注册只是让派生轴可解析）· 实体无 subject 列 ✓（新表是 profile 不是实体标注）· 跨科=mesh 边 ✓ · AI 合同 subjectId-scoped ✓（KILL-1 修复正是为兑现此条）· synthetic root=工程便利 ✓。

## 4. 实施切分（PR 序，依赖：PR1/PR2 并行先行 → PR3 地基 → PR4/PR5 → PR6 → PR7）

| PR | 内容 | 关键点 |
|---|---|---|
| PR1 | `getKnownSubjectIds()` 运行时派生 + 11 消费者分流（类型位放宽 string）+ `GET /api/subjects/choices` + `listSubjectChoices` render/query 化（WelcomePage 模块级冻结修复）+ `target-discovery.ts:678` stale-const | 纯 refactor，register 即可见 |
| PR2 | scope_key L1 三调用点统一（推荐全 RAW）+ 非幂等 id 回归测试 | cosmetic，独立 |
| PR3 | `subject_profile` + alias 表 + migration + 4 builtin 种子 + boot 水合（app+worker）+ `upsert()` + **`subjectProfiles`/`defaultSubjectProfile` 模块常量 stale 消费点审计**（grep import → 改函数调用） | 地基，零行为变化；KILL-1 修复落点 |
| PR4 | `ensureSubjectRoot` 重构 + 创建路由/`insertGoal` 接线 + `subjectDisplayName` passthrough + bridge 词表注入审计 + nightly ≥5 KC gate | 通电桩 |
| PR5 | 写路由 + validateProfile 422 门 + admin CRUD 编辑器 + 校验 badge + reset-to-default | 前置 UI design doc（与 PR6 合一份） |
| PR6 | onboarding 自由文本 thin-create + 通用模式 badge | **前置新 UI design doc + owner 批准**（全库无现行 doc 覆盖手填科目；最近先例 cold-start-day-one-design.md:138） |
| PR7 | audit:profile `--db` + 夜间 cron `--strict` + revision 历史（可选层） | 治理闭环 |

## 5. 诚实缺口（实施期首验项）

① `KnownSubjectId`→string 放宽与类型摩擦点未跑 tsc；② `upsert()` 绕 register-throw 的不变量影响 + `subjectProfiles` 模块常量 stale 消费点未 grep 穷举（PR3 首验）；③ thin-create clone general 的逐字段合法性未验证；④ bridge 词表加宽对 closed-set 分类器的稀释是推理非实测；⑤ alias 表写时唯一性校验（两科抢同别名）未展开。
