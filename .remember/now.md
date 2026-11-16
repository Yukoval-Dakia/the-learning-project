
## 18:12 | unknown
PR #1733（新做题页第 1 片）回归验证已完成，但 CI 仍在重跑（新提交 00c9274，全绿后合并）；外置盘 /Volumes/YukovalSBak 18:08–18:10 临时拒读写，现已恢复，阻塞解除；展示后端 caf6cfd2d 已推上，适配层等积木改完、#1731 与 #1733 合入后再接入。
## 18:21 | unknown
PR #1733 已合入 main（1e7cc8992，21 项 CI 全过，丢字/冲突场景实测一致）；决策定「纸面」版式、新页面默认无开关并记入决策记录；第 2 片（新做题页替换旧单题页、删无人用旧代码，合并前逐项实测 YUK-1484–1489 及冲突面板/返回流/教练抽屉/自评/申诉/Copilot·Today 入口/窄屏，PR 描述列删除清单）已开工，积木转换层待第 2 片合入后接入；学习伙伴位置与吉祥物（含 three.js）待协调线在决策页定，仍未决。
## 2026-10-22 19:05 | UI line
- **Owner direction:** the choice between A, B and C is still unanswered (http://192.168.50.216:8821/). The shell and 今日 page wait for it.
- **Record page:** a subagent is wiring it to the #1956 history reads, in tlp-wt-record after a normal merge of main.
- **Backend gaps:** questions has_mistake and the history fields G8/10/11/12 stay with the main line.
- **Migration line:** it asked to take three items: server/start/routes/onboarding.upload.tsx, routeTree.gen.ts, and the onboarding segment of web/src/router.tsx. None of my branches touch them, so they're handed over. The record and questions branches only edit the record and drafts/mistakes segments of router.tsx.
- **Next:** turn the record, questions and companion branches into PRs, normal-merging main first.
- 19:17 **Record history wired** (tlp-wt-record, 661dd1d88..012cacf05, local only). It reads /history, keeps "at finish" and "now" apart, maps evidence.missing to wording, and keeps prior_runs.
  - **Audits:** typecheck, lint, learner-copy and api-client pass. Two audits still fail, both inherited from the shell and companion base: architecture-deepening (ui-next re-export files, CompanionMount, use-recent-conversations) and capability-boundaries (3 cross-capability links, a baseline that needs tightening, PracticeSolo growing to 1192). These must be fixed before any PR. The fix depends on how the shell is re-planned.
  - **Backend gaps:** list `title` is always null; sessions without evidence are not listed; the live ask_resolved event carries no time; extract-lane items return state_at_finish as unknown.
- 19:11 **Owner on A/B/C:** 「abc都不咋地，有点为了不一样而不一样」. I asked two questions: whether to use a standard Linear-style skeleton, and which of the six things seen so far were right. Waiting for the answer.

## 2026-10-23 03:55 | UI line
- **V3 prototype:** delivered (_work/taste/, 16 screens). The owner hasn't chosen the shell/today direction.
- **Shipping plan for work that doesn't depend on the direction:** three standalone PRs, each built on main without the new shell:
  1. Companion (tlp-wt-companion, 5 commits). The subagent is merging main and clearing the audits now. Then: Opus xhigh data-loss review, push, exact CI.
  2. Questions: cherry-pick 428149c6f, 131464248 and 491dae188 onto main plus the companion PR, adding only the ui-next primitives it needs.
  3. Record: cherry-pick c1c7cb84f..012cacf05 onto main. It uses the #1956 /history reads.
- **Off limits:** the migration line exclusively owns the practice transport (practice-client, use-practice-submit, Start practice route, 2014 serving schema/public/host).
- 05:25, 10-23. Three UI PRs merged, all with match-head squash:
  - #2020 学习伙伴, 9cf9e2a0a: CopilotDock removed.
  - #2022 题目库, 9e1e99bc8: 题库, 错题本, 草稿审核 and question detail are now one page.
  - #2023 录入页, 45c835c7e: reopening reads /history.

  Each PR had one Opus R1 and one R2, and its P1s were fixed. Real-page checks: #2020 was tested for real; #2022 and #2023 were read-only.
  - **Gaps:**
    - stop while the reply is streaming was not verified;
    - the backend run on that sample failed;
    - the TEST backend has no /history;
    - the write paths were not run.
  - **Backend asks** are filed with the lead: session/mistake Idempotency-Key, a partial→reviewed route, list title, has_mistake.
  - **Still waiting** on the owner to choose the shell/今日 direction; the V3 prototype is at _work/taste/.
  - **Cleanup:** the old branch yuk-1473-shell-rebuild is PARKED, and node_modules was removed from all four worktrees.
- 08:12 10-23: #2031 merged (9c190de20), adding classic explicit review on the 录入 page (partial only); R1 approved, Codex had no findings; nothing run on a real page. node_modules removed again.
