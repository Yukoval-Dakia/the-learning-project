# 自定义块准入前预演与真实准入接线

交付阶段：第一天能用。Refs YUK-1513；不关闭整票。代码资产写入已由 #1994 交付，本片不重写该职责。

授权来源：原 [YUK-1513](https://linear.app/yukoval-studios/issue/YUK-1513) 的 v2 设计与评论 `7dbf878b`、`84b0c3d6`，以及本片协调裁定 `d57a1a65-9367-43b9-b87e-f14925b060b1` / `d8df265d-d353-4347-9d70-cf1427cfc115`。协议真相源为 [presentation spec §1.3–1.3.2](../design/2026-10-16-presentation-spec-v1.md)。外部批准设计：`/Volumes/YukovalSBak/yukoval-projects/tlp-status/discussions/custom-block-sandbox-plan.md` 修订 v2。

实际工作树：`/Users/yuqi/.t3/worktrees/the-learning-project/t3-410d4984`。原 T3 分支 `t3/yuk-1513-custom-preview-admission` 的 `ee4b92bea329dde7d88609469e217dd2bb473c1d` 保留；正常 fetch 后从 actual `origin/main` **dbf9b74274011d48738e03b1c241e41e5ede3e66** 新建 `feat/yuk-1513-custom-preview-admission-20261022`，未 reset/force。唯一实现 writer；PLAN/.remember 为 ignored 本地交接，不提交。

## 本片行为与职责

R8 既有 custom 代码资产先经 `shared-submit.ts` 原唯一 publisher 的 `readAssetBytes(storageKey)` 屏障，可发布为 pending admission。只注入现有 R2 reader，保留资产存在性、内容地址、digest、mime、长度与禁序核验及原锁/CAS/请求回执。

`question_admission_run` 完成原 claim → paid admission → 独立 immutable receipt 持久化之后，在所有 application 业务锁之外调用私有预演操作。操作根据原判分结果，复用只读 `buildResolvedPublishContract` 取得将要发布的最终候选；不因为预演失败把原 builder 的 `admitted` 提前改为 false，从而退回旧 base contract。没有 custom 的题目原路返回，无浏览器、资产查询、预演证据或新增记录。

私有操作先读取资产元数据，复用现有 `createAssessmentAssetLoader` 核对 row digest/size，以既有纯 `verifyCode` 对同一 buffer 校验/严格 UTF-8 解码。每个 asset 一次读取，多个 block 复用该 buffer；同一 buffer 同时用于 shell 和 publisher 的 storage-key 缓存 reader。代码只通过既有 `buildShell`、`buildInit`、`validateMessage` 协议进入隔离 iframe，没有第二套 codec。逐块顺序执行，不新增队列、Task、注册器或 worker 并发。

application 事务重新锁定原 paid family / delivery / root / lifecycle，并完成原 freshness 与准入检查。私有决定严格比对最终 contract 的实际四层与 presentation 指纹、声明 digest、全量 custom binds/slots 指纹、冻结 revision/digest/generation 和原 receipt 摘要；另核对当前 revision/digest、实际 CAS generation 与本次 publish 参数。原 paid generation 原样保留，合法 re-pending 的实际 application generation 单独记录，不改写旧 paid 输入。

预演失败时保留该最终候选 contract 和原 paid binding，将实际 publication 改为 withheld，并写 verification.failed + `evidence.custom_block_preview`。操作返回的最终 `admitted` 同时控制 job status、`projectAdmittedQuestionRow` 分支和 paid application status；不会出现已 withheld 却回报 admitted。结构/资产屏障或身份绑定失败保持 pending/抛出原屏障错误，记录 application failure，paid receipt 仍为 receipt_ready，不签发应用成功。未知 paid outcome 的原分支不进入预演，不重发模型；receipt-ready 重放只重做免费预演与应用。

## 具体资源边界

批准输入固定为每 block 总 **15,000ms**（含启动）；ready **3,000ms**、激活后移出焦点的完整观察 **3,000ms** 都包含在该总窗中，剩余不足拒绝，绝不延长或缩短观察后记 pass。整棵自有进程树 **536,870,912 bytes（512MiB）**。job 的既有 AbortSignal 继续约束全部 block；取消会强制终止浏览器并保留 receipt，不将取消当作有效预演结果。

仅支持已具备以下条件的非 root Linux worker。准备失败直接 unavailable，任何不可信字节执行之前必须完成边界建立；本片不安装工具、委派权限、调整宿主/容器或部署：

- `/sys/fs/cgroup/tlp-custom-preview` 是真实 cgroup-v2 委派根，memory controller 已启用，worker 可创建自有叶子并写 `memory.max`、`memory.swap.max=0`、`memory.oom.group=1`、`cgroup.kill`，且能读取 counters、membership 和 /proc sandbox 状态。
- 现有 `/bin/sh`、`/usr/bin/timeout`、`/usr/bin/unshare` 可执行；系统允许该非 root 用户建立 user/network/PID/mount namespace（含 proc 挂载），以及 Chromium 自己的嵌套 user namespace/seccomp sandbox。没有安装或提权回退。
- 现有 Playwright Core 及其 browsers.json 可读，`PLAYWRIGHT_BROWSERS_PATH` 为绝对路径，存在其钉住的 Linux x64/arm64 chromium-headless-shell。操作不下载浏览器，不要求新生产 entry/build/package/Docker hunk。

每 block 创建空 HOME/profile/tmp 和单独 cgroup。受控临时 shell launcher 先将自己加入 cgroup，再 exec OS timeout → unshare → 真实 Chromium；所有后代继承硬内存上限。PID namespace 的 init 被杀时由 kernel 杀掉 namespace 内后代，独立 OS timeout 和父进程 deadline/cgroup.kill 不依赖 `browser.close()` 回应。没有 `--no-sandbox` 或禁用 seccomp/setuid 的回退；Playwright 显式 `chromiumSandbox: true`，实际 argv 复核禁止关闭 sandbox 的 flags，并在执行代码前用 /proc 确认 renderer 额外 user namespace / seccomp 层、NoNewPrivs、隔离 network namespace 和 cgroup 成员。缺少证明即 unavailable。

Chromium 只获得显式 PATH/HOME/TMPDIR/LANG，不继承 provider/DB/internal token、cookies 或旧 profile。通信只走匿名 debugging pipes。独立 network namespace 没有宿主/LAN/localhost 接口；另设 offline、全部 route abort、WebSocket close、serviceWorkers block、空 permissions、禁止下载，并拒绝外部页面和导航。shell 由 setContent/srcdoc 载入，无需 app/R2/本地 HTTP origin。

配置与实际证据分开：`configured_limits` 记批准值；每 block 的 `enforced_limits` 只有实际 membership/kernel sandbox/network 检查成功才非 null，同时记录 enforcement 类型、观察时长、每 bind 真正收到的 slot_id、失败原因。失败/未运行不会写 pass。运行总窗到期立即杀进程；随后仅做有界 kernel 退出回收/目录清理，清理失败也拒绝。`elapsed_ms` 包括回收时间，不伪装成浏览器持续运行时间。

现有 Dockerfile 的 worker stage 只安装 headless-shell，现有 Compose worker 没有委派可写 cgroup 根；所以本片源码交付不意味着现役 worker 已能执行预演。Mac 原生进程同样 unavailable。将来准备环境和真实验收需要单独授权，不能用 V8 heap、RSS 轮询或不受限 Chromium 替代硬 cap。

## 协议、焦点与失败观察

iframe 只获本 block 的公开 binds / select item_id+label 与空 entries，没有 keys、rubric、其他题目、身份、草稿答案或令牌。块必须真的通过 shell MessageChannel 发出信封，Node 用既有 strict validator 整条验证；不能由 driver 生成合法答案，不能凭块宣称 pass。任一 invalid/extra key/unknown/空 answered 使整条预演拒绝；最终必须覆盖每一个 bind。

生成代码只在 sandbox allow-scripts 的 opaque-origin iframe 中执行。trusted main frame 使用有界队列，Node 只轮询这个 realm，不向 untrusted frame 暴露 Playwright binding。加载抛错、page crash、超时/死循环、内存 counter 触顶、自导航或再次 load、缺 bind、任一非法信封均拒绝。

操作真实 click 激活块、click 块、click 外部按钮后观察完整 3s。用后首次返焦点拒绝；保留原宿主使用前第三次抢焦点和累计 1s >5 / 30s >20 熔断语义、inert 与 next-task hand-back。观察中途失败立即关闭端口并强制清理浏览器。

以下仅为下一次独立获批运行窗的输入与预期观察 TEXT，均 **NOT_RUN**：正常块应由自身发出全部 bind 信封；while(1) 应在硬 deadline 前后终止并拒绝；递增 native/JS 分配应触发 cgroup memory failure；load throw、漏一个 bind、空 answered、多余字段、unknown、自导航/reload、blur 后 refocus 各应拒绝并写原因；取消 delivery 应留 receipt_ready，重放不增加 paid model 调用；no-custom 应不启动进程也不增加预演证据。

## 静态交付与剩余责任

只运行经 `/Volumes/YukovalSBak/yukoval-projects/tlp-status/_work/heavy/heavy.sh` 串行包裹、global2 / lane1 / Node≤3072MiB 的 install、format、typecheck、lint、build 和必要架构 audits。没有新增/修改/运行测试或断言脚本；没有运行资源准备、/proc 检查、Chromium、浏览器、DB、Docker、provider、paid、runtime probe 或部署。最终命令与 exit 在交接中列明；本地日志留 ignored `.remember/`。

首片 e58880173 的本地结果：`pnpm install --frozen-lockfile`、`pnpm typecheck`、`pnpm lint`（181 warnings）、`pnpm build`、`pnpm audit:capability-boundaries`、`pnpm audit:architecture-deepening` 均 exit 0，`git diff --check` 通过。两架构审计实测新增依赖边 0、capability→server/server→capability deep/cross-capability 总数 384/0/36、new pass-through 0；只追加 shared-submit 1162→1164 的真实 sourceSizeRecord。build 完成现有 web/Start/server/worker/migrate 包装链；这不是浏览器或隔离机制实测。首次边界审计因缺该两行 sourceSizeRecord exit 1，补准确登记后通过，未调整审计器或阈值。

### 首次 R1 窄修与主线组合

首次独立 R1 对固定 e58880173 报 P0=0/P1=1：`confirmSandbox` 原先要求 renderer 与 browser 的 network namespace 相等，错误拒绝正常 Chromium 的嵌套隔离。固定 Chromium 156.0.8078.4 的 [NamespaceSandbox 默认选项](https://github.com/chromium/chromium/blob/156.0.8078.4/sandbox/linux/services/namespace_sandbox.cc) 包含 CLONE_NEWUSER / CLONE_NEWPID / CLONE_NEWNET，[zygote 启动路径](https://github.com/chromium/chromium/blob/156.0.8078.4/content/browser/zygote_host/zygote_host_impl_linux.cc) 消费该操作。本轮只将该判定改为 browser 与每个待检查 renderer 的 net namespace 分别不等于 worker hostNet，允许合法嵌套；实际 cgroup membership、额外 user namespace、NoNewPrivs、Seccomp/filters、读取失败拒绝与 OS 前置 failclosed 保持原样。没有修改 runner/admission 或 resolved-publication。

正常 fetch 后将 actual origin/main **4613240143517779a20bd13a34beab31ef0eba48** 合入原分支；与本片只交集 baseline，自动合并无冲突。保留该 main 的 changes/edgeRecords 全前缀及本片真实 shared-submit sourceSizeRecord，不重写 ledger、不调整审计器或上限。父记录的旧 Circle architecture **9449** 失败为分支未纳入其比较基线 4d73 的新增前缀而触发 append-only 拒绝，原失败保留，不称 infra 故障、不重跑旧 Circle；旧 e588 GitHub 绿色不替代新组合的 exact-head CI。修后静态门、唯一 R2 与新 CI 分别交接，仍未运行资源或浏览器验收。

修后与 main4613240 组合的 `pnpm typecheck`、`pnpm lint`（181 warnings）、`pnpm build`、`pnpm audit:capability-boundaries`、`pnpm audit:architecture-deepening` 均经指定 heavy.sh 串行执行并 exit 0；没有重装依赖。审计实测新增依赖边 0、new pass-through 0，384/0/36 不变。日志留本树 ignored `.remember/yuk1513-checks/r1-fix-4613240/`。上述结果只覆盖源码静态门；修后唯一 R2、新组合 exact-head CI 和运行验收尚未由本 writer 验收，本轮不 watch/poll/merge/resolve 或启动审查。

custom serving 继续 withheld；没有改 UI、kernel/schema/publish/serving、manifest、paid/receipt/预算协议。所有其他生命周期 publisher 的 readAssetBytes 全接线仍留原 YUK-1513，不把本片两处 reader 当作全库闭环。真实录入→预演→发行→作答判分、故障和并发恢复、资源隔离可用性均未验收，不关闭整票或另建重复票。

残余风险：通过有限预演仍不能保证迟发或特定交互触发的循环不会冻结学习者页面。网页已有立即保存只能保护最后一条已保存作答，不能阻止标签页卡死；本片不声称预演能够证明恶意代码安全。
