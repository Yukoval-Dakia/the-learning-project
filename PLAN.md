# PLAN — 活看板 (cockpit)

> 本项目的「手边」全局看板：比 `.remember/` 结构化、比 Linear 近手。**driver session 持续更新；收尾必同步**（见 `CLAUDE.md` →「Session Discipline · Cockpit & 全局视角」）。Linear 是**权威**驾驶舱（projects/issues 的真相），本文件是工作面镜像 + 当下决策态 + 在飞清单。四栏：NOW / NEXT / PARKED / BLOCKED-ON。**PLAN.md 是看板不是日志**：正文 ≤200 行、头部只留最新 1 条【更新】+ 更新于戳；超龄叙事段滚存归档、四栏就地改写对齐现实。
>
> 更新于：2026-07-16　·　历史头部日志（2026-06-23 ~ 07-11，含 YUK-597 收伞段）已滚存 → `docs/planning/2026-07-07-plan-header-log-archive.md`（原文保真）。

> **【更新 2026-07-16 · 驾驶舱 re-grounding：07-12→16 五波交付上板 + 生产/在飞实况重建 + stash 孤本抢救】** 看板停在 07-11 收伞，期间 main 落 **35+ PR、两个 program 全交付**：① **产品可用性硬化 UH**（总控 YUK-619，#790 主 PR + 26 单全 Done；计划/验收矩阵 `docs/planning/2026-07-13-product-usability-hardening.md`，容器级 usability gate + runbook `docs/agents/usability-container-smoke.md`；部署面 = 非 root 运行、mem0-init chown、pdfium.wasm、`GET /api/auth/check`）② **API 资源契约收敛 YUK-641~668**（28 单，#792-797+#800-820；152/152 路由声明 + OpenAPI 143 path + `audit:api-contracts`/`audit:no-learning-styles` 双 CI 门禁进 `pnpm test`；唯一尾巴 = legacy alias 删除，evidence-gated 刻意推迟）。另三波：**YUK-617 通电+cleanup 四刀**（#776-781，删 ~1000 行孤儿 + 端点批 ground-truth 纠偏救回 C6/C10/C7 活代码；尾巴见 NEXT）· **YUK-567 备课台 slice-1/2 全链通电**（#782-784，conjecture 卡→accept→probe 文本+图片作答→confirm/refute；edit-claim path deferred）· **YUK-476+614 档案露出**（#772/773，/today ProfileBand，day-one 软缺口闭合）· **YUK-634 + 学科网获取设计草案**（#787）。今日（07-16）：**#823 YUK-506 教学法安全脊 dark-ship merge**（13:48，src/core/pedagogy 无 runtime wiring，**未部署**）；部署窗 10:01 = `287e4e2a`（main@#820 + flag-persist deploy commit → 本 session cherry-pick 回 main = **PR #825 已按政策自主 merge `e963b393`**：全 gate + 独立 opus review APPROVE 折入 + CI 绿 + threads 零）；cloudflared 仍 crash-loop（YUK-615，RestartCount 2456+，fix owner-gated）；**YUK-604 Linear=Done 悖论**（impl 只在 codex worktree 分支未合 main，已评论待 owner 裁）；**stash@{0} 孤本抢救**：1918 行设计深稿（供题控制面研究 + owner Subject Control Plane proposal 原文）本 PR 归档入 `docs/design/`，spike 代码 patch 存 `.remember/tmp/stash0-rescue/`。**同 session 续办**：① 🔴 **YUK-669 凭证泄露（Urgent）遏制**——owner 轮换全部 4 系统凭证 + `#827` 合（tip 除净）+ 仓库转 PRIVATE；剩历史清除 + 启用 secret scanning（详见 ✅）② backlog「继续三批」执行 = **立单 11（YUK-670~680）+ 卫生 15 + 关 24 PR**（详见 在飞 / ✅）。（上一条 07-11 收伞【更新】已滚存 → 归档文件）

## 🎯 主线方向（当前）

**方向 B = 诊断 payoff（owner 拍定 2026-06-23）。** 头号留存钩子 = 「看到我哪错/哪长」的学习者诊断档案（私人教研团终局）。机械架构基底 + 可用性两条腿现已齐：**day-one 软缺口 YUK-476 档案露出已交付**（#772，/today ProfileBand + /profile 入口），**UH 可用性硬化 program 已全量交付**（真相/恢复/旅程/规模/可达性五结果 + 容器级回归门禁）。冷启 day-one 先验仍是底色（记忆 `feedback_cold_start_first`）。

**两条主 project（B 的地基）**：① 领域模型重构 YUK-203 ② 学习者全面档案 YUK-452 / A1-A15。later-organ 侧（关系脑 YUK-406/440、规划脑 B3 YUK-349）承重代码已 CODE-LIVE（drift 审计 07-16 对账），剩验收/closeout/runtime 接线；**教学法脑 YUK-506 安全脊已落**（#823），runtime 大头未做。

## NOW（当前 active 线）

- **供给线主弧（active）**：三件套——① **YUK-604 pending-stall 收口悖论**：Linear 今日翻 Done 但 impl（2 commits）只在 codex worktree 分支 `yuk-604-learning-item-open-status` 未合 main，「激活语义 owner 判词」未见记录；已评论回填，**等 owner/该 lane 收口（开 PR 或翻回状态）**——在此之前供给脊柱断电在 main 上未修。② **学科网真题获取弧**：设计草案已入库（`docs/design/2026-07-13-question-supply-xueke-acquisition.md`），owner 已定全自动 (A)、headless 认证 linchpin 已验证 ✅；fork (b)-(d) + 4 条 follow-up 待 owner 拍角度后落 Linear（见 PARKED）。③ 供题控制面判词底稿已归档（本次抢救，见【更新】）。
- **方向 B「可开始用」milestone — 代码+UI 硬化全齐，剩 gate 不变**：flag ①批 LIVE（07-06 翻、07-16 固化进 tracked compose override，#825 已合）；**剩 gate = 冷库零题（owner 上传/生成内容）→ 首次真实 placement 会话跑通**（空池 `sourcingNeeded:true` 走 quiz_gen 是设计态）。⚠️ 生产 = 本机 OrbStack compose（`tlp-deploy`），外部 ingress 断（YUK-615）。
- **在飞活 lane：#824**（YUK-349 B3 mem0 advisory prior，07-16 当天开的 draft，MERGEABLE）——另一 lane 活跃工作，推进/review/转正归其 lane。

## NEXT（就绪，排队）

- **YUK-506 教学法脑 runtime 大头**：panel-SELECT / efficacy learning / B5 verification / delivery wiring 全 deferred（#823 只落安全脊）。⚠️ **硬前置 = YUK-505 拓扑 amend**（见 BLOCKED-ON）。
- **YUK-617 wave 尾巴**：ReviewIntentTask 退役 + 6 处现行文档叙事清理（AGENTS.md/README×2/architecture.md×3）· C6 `/api/review/sessions` sub-route verify · 端点批 OWNER-DECIDE 待决。
- **YUK-567 尾巴**：edit-claim path（decide route thread `corrected_payload` + mem0 CORE writer 现 no-op）· YUK-616 深读面全集 weakest 待拆。
- **YUK-596 durable-by-default flip（YUK-575 PR2）**：4 条阻断前置不变（#738 终裁评论）；Linear 显 In Progress 与「排队」口径不符，需核。
- **Wave 3 follow-up 批**：YUK-590（Todo）/594（Backlog）/394（Backlog，OCR 额度耗尽勿重跑）口径对齐；**YUK-595/589/593 七天窗外 unknown 待核**，别当已就绪。
- **legacy alias 删除弧（YUK-641 尾巴）**：access-log 证据 + owner 批 Sunset 日期 + 跨一个发布窗 + 独立可回滚 PR。
- **🦀 Rust YUK-495**：YUK-455 已 Done（07-11）；Phase 0+/2 余项仍需 re-ground。

## PARKED（已捕获，不是现在）

- **红线审查 owner 拍板菜单剩 6 项** = `docs/audit/2026-07-07-redline-challenge-audit.md` §5（step9 断言 / P6 到期悬崖 / X2 成本叙事 / A2 执行状态列 / A3 勘误 / /audit-drift 通电）+ sweep 溢出 2 条。
- **brainstorm 存活 8 条** = `docs/design/2026-07-06-agency-data-brainstorm-portfolio.md`；红线挑战组 3 条未拍板。
- **🧠 misconception 建模调查 + MISCONCEPTION_PROMOTE flag 设计**（docs 存档 2026-07-01）。
- **YUK-608 verify 同模型自证盲区**（owner 拍方向；选项①异源 solve/verify 推荐）。
- **Linear 卫生（07-16 重校）**：✅ 已清 = YUK-519/531/476/560（Done 落地）。**待 owner 复核批** = ① YUK-604 Done 悖论（见 NOW）② **YUK-407 今日被反向翻 In Progress**（红线建议是翻 Done/收口）③ YUK-351（标题工作疑已随 #490 完结却 In Progress）④ YUK-354/406 epic 空翻 In Progress（#823 收口 deliberate retained-with-gates，但活跃度存疑）⑤ YUK-571 宜降 waiting-owner ⑥ YUK-405 In Progress 疑空翻。**YUK-303/306/373/375/360 七天窗外 unknown 待单独核**。
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

- **PR 在飞**：**#824**（YUK-349 draft，另一 lane 活跃；⚠️ 未解 bot threads：CodeRabbit kernel-facade Major + OCR double-serialization，merge 前须按 thread-check 纪律处理）· **#791**（dependabot batch，YUK-671 承接）· 本 plan-sync docs PR（**#826**，CI 绿待 owner 合）。**本 session 已合**：#825（`e963b393` flag persist）· **#827**（`7f17e9ed` YUK-669 安全遏制，见下）。
- **backlog-engine 2026-07-16 已执行（owner 批「继续三批」，43-agent grooming）**：**立单 11 = YUK-670~680**（Dependabot 安全 670/671 · meta_cause 672 · ADR-0042/0011/0047/0048/0046/0041 673/674/675/678/679/680 · 学科网 follow-up 676 · matcher 标定 677；project+parent+relate 已挂）· **Linear 卫生 15 全 done**（368→444 并单 + close 143/89/173/490/208/50/210 + 重写 213/211/430 + 对齐 360 + 扩 428/618 + 431 挂 project）· **24 PR 关闭**（20 audit-drift #544→#821 + 4 僵尸 #590/465/466/588）。全文档 `.remember/tmp/backlog-engine-2026-07-16.json`；B 段 9 低优 + C 段映射未动（下轮）。draft#1（stash 抢救）已由本 PR 解决。
- **生产 = `287e4e2a`**（= main@#820 + flag-persist）：**#823（YUK-506 安全脊）未部署**——dark-ship 零 runtime 影响；#825 已合，**下个部署窗直接从 main（`e963b393`）前滚即携 #823+#825**。**外部 ingress 断**（YUK-615，cloudflared crash-loop 2456+ 次，fix owner-gated）。
- **未合分支悬挂**：codex worktree `yuk-604-learning-item-open-status`（2 commits，YUK-604 悖论见 NOW）。
- **worktree 拓扑（07-16 实况）**：主工作树 + `tlp-deploy`（`287e4e2a`）+ `tlp-yuk599` / `tlp-yuk476` / `tlp-usability-hardening` / `tlp-pr787-fix` / `/private/tmp/tlp-yuk571` + codex×2（yuk-349 / yuk-604）+ cursor×2 + **`.claude/worktrees` 27 只契约波残留（可清）**。
- **待 owner 清理分支**（squash-merge 后 guard 挡删）：yuk-249×2（+远端）· yuk-597~602 批 13 只 · `yuk-634-docx-bare-question-number` · `yuk-571-placement-go-live`（flag commit 已由 #825 收编）· `yuk-571-persist-flags-main`（#825 已合）。

## ✅ 最近已落（防遗落，下次别重做）

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
