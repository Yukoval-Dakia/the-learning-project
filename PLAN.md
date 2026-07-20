# PLAN — 活看板 (cockpit)

> 本项目的「手边」全局看板：比 `.remember/` 结构化、比 Linear 近手。**driver session 持续更新；收尾必同步**（见 `CLAUDE.md` →「Session Discipline · Cockpit & 全局视角」）。Linear 是**权威**驾驶舱（projects/issues 的真相），本文件是工作面镜像 + 当下决策态 + 在飞清单。四栏：NOW / NEXT / PARKED / BLOCKED-ON。**PLAN.md 是看板不是日志**：正文 ≤200 行、头部只留最新 1 条【更新】+ 更新于戳；超龄叙事段滚存归档、四栏就地改写对齐现实。
>
> 更新于：2026-07-20　·　历史头部日志（2026-06-23 ~ 07-19）已滚存 → `docs/planning/2026-07-07-plan-header-log-archive.md`（原文保真）。

> **【更新 2026-07-20 · 「继续收backlog」两波连清：第二轮 6-lens 扫描六票 + YUK-546/549 并发硬化，agent 再合 10 PR】** 12h 收口后 owner 指令「继续收backlog」，本波 agent 10 PR 全自主合入（#949 看板 + #959/#960/#961/#963/#965/#969/#970/#971/#972）。① **P0F/6 收官**：YUK-710 简报 telemetry + 两周存活报告（#960，十轮 review 全收口——funnel 与 reader 交付口径逐轮对齐、brief_seen 跨午夜 visibilitychange+action 前重发、CLI 入口 resolve 守卫、空串 join-key 守卫）；② **第二轮 6-lens 扫描（25 agent，16 条对抗验证 confirmed）→ YUK-729~734 六票全 Done**：#965 paper-submit 有界 brief-regen fan-out + backup-import OOM 三层闸（729）· #959 ingestion SSE 四守卫移植 + 高水位 cursor（730）· #961 KaTeX 按需 + SSR warm-up（731）· #963 PfPaper 退出 flush/keepalive 累计预算/互斥（732）· #970 三 GIN(jsonb_path_ops) 索引 + inbox SELECT 瘦身（733，EXPLAIN 证据入 PR）· #969 三件测试缺口 26 测（734）；③ **YUK-546 第 2 件 propose 侧对称锁（#971，五轮并发深挖：TOCTOU lock-then-revalidate → 行锁-advisory 全序统一 → 三端点 NOWAIT+有界重试 → 退避窗对齐 merge tx；1/3 件评估备忘 + 第 4 gated follow-up 落 Linear 评论,票回 Backlog 等 owner）+ YUK-549 oracle 打磨三件（#972，prefetch Map 化+SQL 收窄、golden 捕获砍裸腿、ProjectionAdapter registry 化）**。新立：YUK-736（drizzle snapshot 断链 DX）· YUK-737（supersede/直连 POST /api/edges 拓扑门缺口,546 子票）；YUK-735 已由并行线（#968,归属不明,driver 未碰）In Review。ready-for-agent 队列清空；生产未动。（上一条 07-19 【更新】已滚存 → 归档文件）

## 🎯 主线方向（当前）

**方向 B = 诊断 payoff（owner 拍定 2026-06-23）。** 头号留存钩子 = 「看到我哪错/哪长」的学习者诊断档案（私人教研团终局）。机械架构基底 + 可用性两条腿现已齐：**day-one 软缺口 YUK-476 档案露出已交付**（#772，/today ProfileBand + /profile 入口），**UH 可用性硬化 program 已全量交付**（真相/恢复/旅程/规模/可达性五结果 + 容器级回归门禁）。冷启 day-one 先验仍是底色（记忆 `feedback_cold_start_first`）。

**两条主 project（B 的地基）**：① 领域模型重构 YUK-203 ② 学习者全面档案 YUK-452 / A1-A15。later-organ 侧（关系脑 YUK-406/440、规划脑 B3 YUK-349）承重代码已 CODE-LIVE（drift 审计 07-16 对账），剩验收/closeout/runtime 接线；**教学法脑 YUK-506 安全脊已落**（#823），runtime 大头未做。

## NOW（当前 active 线）

- **backlog 连清收口（07-20 晨）**：ready-for-agent 队列已清空；agent 在飞 PR = 0（本看板 docs PR 除外）。剩余 Backlog 大头是 owner 拍板项（见 NEXT 决策菜单）。
- **#968（YUK-735 subject notation）In Review,归属不明**：18:21 起 In Progress 不在 driver lane 记录里,疑 owner 并行线——driver 未碰,由 owner 处置。
- **dependabot 5 PR 待收（#953-957）**：#953 = prod minor/patch group 22 项;#954-957 = 四只 major（react-markdown 10 / ai 7 / undici 8 / @ai-sdk/anthropic 4）。对应 YUK-671;major 触 AI provider 双通道,须单独 lane + 迁移笔记。
- **jyeoo 供给链 dark-ship 待 owner**：`JYEOO_FETCH_ENABLED` 默认 OFF;开闸前过目 producer patch 提案 doc。
- **安全 owner/operator lane = YUK-669**：历史清洗/force-update 与 secret scanning 仍 owner 门控,禁止 agent 自行执行。

## NEXT（就绪，排队）

- **dependabot 队列（YUK-671）**：先收 #953（minor/patch group,全量 gate 后合）;四只 major（#954-957）逐只单 lane,`ai`/`@ai-sdk/anthropic` 两只须对照 `src/server/ai/AGENTS.md` 双 provider 机制写迁移笔记。
- **owner 拍板菜单（本波新增）**：YUK-546 第 1 件（级联 vs guard,备忘推荐级联）+ 第 3 件（partial index,备忘裁 NO-GO 除非三合一）· YUK-736（snapshot 修链 vs 成文）· #968/YUK-735 归属确认。
- ~~YUK-737 拓扑门缺口~~：**已于 07-20 08:36 经 #974 合入 Done**（supersede/直连 POST 双路径补门,scaffold 抽共享 edge-topology-write.ts,create 分支同迁）。
- **YUK-727 jyeoo 图题 figures/R2 glue**：#939 走了「持久化前过滤」路径,完整 asset 管道拆此票;开 JYEOO_FETCH_ENABLED 前非必需。
- **YUK-354 / YUK-169 umbrella 余项**：按已有形态轴和 redraw brief 继续 slice-by-slice；UI 仍逐刀做 design-doc pre-flight。
- **YUK-506 教学法脑 runtime 大头**：panel-SELECT / efficacy learning / B5 verification / delivery wiring 全 deferred（#823 只落安全脊）。⚠️ **硬前置 = YUK-505 拓扑 amend**（见 BLOCKED-ON）。
- **YUK-617 wave 尾巴**：ReviewIntentTask 退役 + 6 处现行文档叙事清理（AGENTS.md/README×2/architecture.md×3）· C6 `/api/review/sessions` sub-route verify · 端点批 OWNER-DECIDE 待决。
- **YUK-567 尾巴**：edit-claim path（decide route thread `corrected_payload` + mem0 CORE writer 现 no-op）；YUK-616 深读面全集 weakest 已于 #877 完成。
- **YUK-596 durable-by-default flip（YUK-575 PR2）**：4 条阻断前置不变（#738 终裁评论）；Linear 显 In Progress 与「排队」口径不符，需核。
- **Wave 3 follow-up 批**：YUK-590（Todo）/594（Backlog）/394（Backlog，OCR 额度耗尽勿重跑）口径对齐；**YUK-595/589/593 七天窗外 unknown 待核**，别当已就绪。
- **legacy alias 删除弧（YUK-641 尾巴）**：access-log 证据 + owner 批 Sunset 日期 + 跨一个发布窗 + 独立可回滚 PR。
- **🦀 Rust YUK-495**：YUK-455 已 Done（07-11）；Phase 0+/2 余项仍需 re-ground。

## PARKED（已捕获，不是现在）

- **红线审查 owner 拍板菜单剩 6 项** = `docs/audit/2026-07-07-redline-challenge-audit.md` §5（step9 断言 / P6 到期悬崖 / X2 成本叙事 / A2 执行状态列 / A3 勘误 / /audit-drift 通电）+ sweep 溢出 2 条。
- **brainstorm 存活 8 条** = `docs/design/2026-07-06-agency-data-brainstorm-portfolio.md`；红线挑战组 3 条未拍板。
- **🧠 misconception 建模调查 + MISCONCEPTION_PROMOTE flag 设计**（docs 存档 2026-07-01）。
- **YUK-608 verify 同模型自证盲区**（owner 拍方向；选项①异源 solve/verify 推荐）。
- **Linear 卫生**：07-18 已复核本轮触及票；YUK-674/683/535/534/332/334/609/211/673/349/328/616 均 Done，YUK-354/YUK-169 deliberate retained-with-gates。其余 07-16 待 owner 复核批（YUK-604/407/351/406/571/405）仍保留，未凭旧叙事擅自改状态。
- **学科网获取 4 follow-ups（待 owner 拍角度后落 Linear）**：阅读篇父题分组 · 数学/物理 MathType OCR-visual 保真验证 · 全自动认证工程（会话 TTL/下载流/容器化）· P1 落地三件（因果链事件总线 / content_hash 去重门 / intent 标记表）。
- **stash@{0} 残余证据**：panel JSONs + eval 报告（~17k 行）仍 stash-only；spike 代码 patch（runner.ts +75 / task-prompts.ts 重写 / spike 脚本 +308）= `.remember/tmp/stash0-rescue/stash0-tracked.patch`，续 spike 时从 patch 恢复，**勿整包 `stash pop`**（夹带无关改动）。
- **周期清单（07-16 执行后）**：✅ audit-drift 20 只（#544→#821）+ 4 僵尸（#590/588/465/466）**已关**；dependabot 10 只由 YUK-670（8 alerts）/671（队列 desaturate，含 #679/678/680 三 major）承接。**infra 清扫仍挂**（不在「三批」授权内，分类器挡）：`.claude/worktrees` 27 只契约残留 · 12 只 `tlp-yuk621-e2e-*` exited 容器 · cloudflared crash-loop（`docker stop` 止噪）· 17 个 stash · tlp-deploy 两空 volume——**待 owner 显式点名或加 Bash 白名单**。
- **栈瘦身 / Rust tripwire / C7-C10 matcher cleanup / tlp-deploy 空 volumes**（不变）。**Step6 [ops] always-on 部署 = YUK-615 隧道**（cloudflared crash-loop 2456+ 次，fix owner-gated：`.env` TUNNEL_TOKEN + `up -d cloudflared`；不修可先 `docker stop` 止噪）。

## BLOCKED-ON（在等什么）

- **YUK-505 规划脑 deliberative panel → runtime 前必须先 amend 拓扑**：六月四角色 fan-out 设计与七月 YUK-572「单 director + ≤1 conditional scout」anti-swarm 契约冲突（drift 审计 07-16 Contradicted ②）；须裁「独立 gated planning job vs 单-director 规划模式」，不得隐式扩 YUK-572 spawn 面。
- **profile P2 翻 flag**（misconceptionRecurrence / B4 answer_class filter）← 需数据 + judge 校准。
- **matcher 接 live caller** ← 题库规模 + Step2 feeder 验证。
- **教研团 YUK-405 / 记忆 YUK-322** ← profile 有真实数据 / 交互历史。
- **A9 step-grading 倍增器（YUK-438，#522 draft 停滞近月）** ← judge 校准数据（YUK-573 report-only 采样中；二期 YUK-589）。

## 在飞（PRs / workflows / worktrees）

- **PR 在飞**:本看板 docs PR(cockpit-sync-0720,docs-only,merge 待 owner 授权)+ #968(YUK-735,归属不明,driver 不碰)+ dependabot #953-957。agent 本波 10 PR(#949/959/960/961/963/965/969/970/971/972)已全部合并。
- **worktree / 分支存量**:本波 6 只 lane worktree(yuk710/733/734/546/549/cockpit 前五只)已随 merge 清除;`git worktree list` 仍 99 行(含 40 只历史 tlp-wt-* + `.claude/worktrees` 契约残留),**本地遗留分支 ~749 只**(squash-merge 后 `-d` 拒删,git-guard 不 `-D`)——批量清理属 infra 清扫,待 owner 点名。
- **外部/owner 门控**:YUK-669 历史清洗;GitHub Actions billing 零步失败(YUK-712)——本波每 PR 由 OCR/codex/CodeRabbit(已复活)1-10 轮有效 review 覆盖,merge 证据=本地分段 gate 真实 EXIT 行。
- **本地工作树**:owner 既有未跟踪文件(`.codex/*`、`AGENTS.md`、jyeoo 设计 doc)未暂存未改写;jyeoo-rs 仓库只读未动;主工作树未 pull(driver 全程 worktree 作业)。
- **🔴 基建注意(08:30 后升级)**:Docker fsync IO 退化已过悬崖——**单个 S2 分片(61 文件)连 testcontainer setup 都撑不过 10 分钟窗**(两次 setup 期被杀),仅 ~23 文件定向跑可完成(~8 分钟)。**owner 重启 Docker/OrbStack 前,一切需 full-shard db gate 的 merge 实质被阻**(#974 已按定向跑+lane 双源证据如实合入)。dependabot #953 另被供应链 minimumReleaseAge 政策挡到 ~08:40Z(katex 0.18.1 出窗),政策保持不放宽;#954-957 四 major 需 full S2,同被 IO 悬崖顺延。**dev compose 库(:5433/loom)schema 落后于 main**(缺 YUK-221 `ordinal` 等,audit:projection 对 dev 库跑不了——owner 下次 `pnpm dev:local` 迁移即复原)。YUK-724 flake 第 3/4 次已记录,建议并发隔离。

## ✅ 最近已落（防遗落，下次别重做）

- **07-19→20 「继续收backlog」两波连清（agent 10 PR）**：P0F/6 telemetry 收官(#960 十轮)+ 第二轮 6-lens 扫描六票(#959/961/963/965/969/970)+ YUK-546 第 2 件五轮并发硬化(#971:TOCTOU→锁全序→三端点 NOWAIT,是本 session 最深的并发链)+ YUK-549 oracle 三件(#972)。沉淀:drizzle snapshot 断链(YUK-736)· merge 行锁批不完整 gated follow-up(546 评论)· 拓扑门缺口子票(YUK-737)。ready-for-agent 队列清空。详情见头部【更新】。
- **07-19 12 小时双线推进（agent 17 PR + owner 并行 ~12 PR）**：P0F 教研简报闭环 P0F/1-5（契约/read model/简报 band/幂等 ack 写端/练习 CTA 在飞）+ jyeoo-rs 确定性供给 dark-ship（#939,kill switch OFF,producer patch 提案待 owner）+ 优化七票（诚实失败链/两处 render-memo/a11y wave/server 读路径/mathjs async/批量读)+ YUK-221 ordinal。ack 写端沉淀模式:**writer 接受集 ≡ reader 交付集**(单源判词 loadOutcomeBrief 进事务+锁)。gate 纪律新增:S2 超 10 分钟窗时按目录四分片,每片独立 testcontainer。详情见头部【更新】。
- **07-18 12 小时产品推进（#836/#867-891，26 PR）**：遗留正确性/供给/投影/会话链清扫 + SPA 重分块/重依赖按需加载 + Inbox/Copilot/onboarding/notes/today/record 可用性与 a11y 连续打磨；最终 main `f99e5382`，开放 PR 0，完整验证数字与 issue 状态见头部【更新】。
- **🔴 YUK-669 凭证泄露事故遏制（2026-07-16，Urgent）**：仓库一度 PUBLIC + tracked `.env.local.bak`（Neon/Postgres · `CLAUDE_CODE_OAUTH_TOKEN` · Tavily · Vercel OIDC 真凭证）。owner 已**轮换全部 4 系统凭证** + 仓库转 PRIVATE（0 forks）；**#827 已合**（`7f17e9ed`，`git rm --cached` + gitignore `.env*.bak`，tip 已除净）。取证：`.env.local.bak` 是唯一真泄露文件，其余 grep 命中全假阳性。**剩 owner 门控**：历史清除（`af4651d9` 在多分支，需 filter-repo + force-push）+ 启用 GitHub secret scanning（当前 DISABLED）。全程零凭证值落地。
- **backlog-engine 全量 grooming 执行（2026-07-16，「继续三批」）**：43-agent 对抗 grooming → **立单 11（YUK-670~680）+ Linear 卫生 15 + 关 24 PR**，26 次 Linear 写零拦截零失败。产物 `.remember/tmp/backlog-engine-2026-07-16.json`（含未动的 B 段 9 低优 + C 段映射，下轮）。driver+linearscribe(opus) 分工;立单 ground-truth 全核对。
- **驾驶舱 07-16 re-grounding + stash 孤本抢救（本 PR #826）**：PLAN.md 07-12→16 五波补板（UH/API 两 program + YUK-617/567/476/634/506）+ 生产/在飞实况重建；抢救 1918 行 stash-only 设计稿入 `docs/design/`（供题控制面研究 + Subject Control Plane proposal）。
- **产品可用性硬化 UH program 全交付（2026-07-13→14，#790 + 26 单 Done）**：U0 真相/恢复（evidence-backed 冷启、401 TokenGate、AI runner preflight、fail-closed mutation、时间预算、KPI 真相）· U1 旅程（hint、false-success 移除、PDF 渲染打包、DOCX 清理、事件证据详情）· U2 规模（观测聚合、learner 语言、题库分页、surface inventory、动态 SubjectProfile）· U3 可达性（drawer/表单语义、时区、a11y、**容器级 usability 回归门禁** + runbook）。部署面：非 root、mem0-init、pdfium.wasm、/api/auth/check。
- **API 资源契约收敛 YUK-641~668 全交付（2026-07-14→15，#792-797 + #800-820，28 单）**：papers/review-sessions 拆分 → proposal decisions 统一 → ingestion operations 化 → attempt/transition 收敛 → 201/202/Location/cursor 契约 → OpenAPI 生成 + **boot/CI 双 fail-closed**（`audit:api-contracts` 0-legacy 门禁 + runtime `route_contract_violation`）。全程 compatibility-first：legacy alias 全在线、无 Sunset。顺带修真 bug：paper autosave 曾发 `answer_md` 给只读 `content_md`。
- **YUK-506 教学法安全脊 dark-ship（2026-07-16，#823 `e128f1ab`，未部署）**：src/core/pedagogy 8-method 闭集 palette + 四信号 StateGuard + 确定性 `selectPedagogyCandidates()` + anti-learning-styles 三锁 + `audit:no-learning-styles`（837 文件）进 `pnpm test`；Linear closeout 关 519/531/560、retain 349/351/354/406 带门。runtime 全 deferred。
- **YUK-617 建成不通电光复 + cleanup 四刀（2026-07-12，#776-781）**：通电 AttemptTimeline 进判定反馈卡 + mode-1 三处接线（ProposalCard tag / 知识树到期徽标 / conjecture-scores admin 第六面）；四刀删 ~1000 行孤儿（MasteryBadge/StatusBadge/corrective-redo/coach-plan/死 route/ReviewIntentBanner/getActiveQuestionState）；**端点批 ground-truth 纠偏救回 C6/C10/C7 活代码**（审计误判死，盲删会砸 live 练习会话链）。
- **YUK-567 备课台 conjecture 全链通电（2026-07-12→13，#782/783/784）**：/today 夜链 chip 就地展开 ≤3 张猜想卡（anti-guilt 硬约束 8 SSR 单测锁）→ accept 铸 mind_probe → 文本+图片作答（`multimodal_direct` vision judge）→ confirm/refute。#783 补修 CodeRabbit 两 Major（面板卡死 + decide 静默失败）。
- **YUK-476+614 档案露出（2026-07-11，#772/773）**：/today 冷启带 ProfileBand（coral 区间 + p_l 标记五态）+ workbench/summary 扩 active_goal；服务端全集派生 weakest-by-p(L) 修 20-截断漏真最弱。设计 doc `docs/design/2026-07-11-yuk476-diagnostic-surface.md`（7 决策 LOCKED）。
- **YUK-634 docx bare 题号修复 + 学科网设计草案（2026-07-14，#787）**：markdown-segment.ts 确定性修复（真卷 21→24 块）+ `docs/design/2026-07-13-question-supply-xueke-acquisition.md`（获取+治理架构，spike/linchpin 发现汇总）。
- **07-16 部署窗（`287e4e2a`）+ flag 固化**：prod 从 `28dcd67f`（07-13）前滚吃下 32 commits（API 契约批等）；placement go-live 双 flag 固化进 tracked `docker-compose.mac.yml`（07-15 曾因 .env 未拷贝被静默翻回 off 的真事故防复发）→ **#825 收编回 main**。
- **YUK-597 v3.2 trait 合同实施批全交付 + 收伞（2026-07-11，生产 `2ab3a964`）**：父单 + 全 7 子单 Done；详情见归档【更新】（`docs/planning/2026-07-07-plan-header-log-archive.md`）。
