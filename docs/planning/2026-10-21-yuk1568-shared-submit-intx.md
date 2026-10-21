# 共享声明提交与真实父子投影（YUK-1568）

2026-10-21；服务「第一天能用」K1 统一判分契约。本片交付声明 sourcing 候选的完整 save/submit 事务与现役 consumer，不代表四类生产端全部完成。

## 当前版本与写权

- 工作树：`/Users/yuqi/.t3/worktrees/the-learning-project/t3-12b32ff3`；分支 `feat/yuk-1568-shared-submit-intx-20261021`。
- 原基线 `214ecb0ef1c2d746316af5831ea79bbaa18345ef`；子线 `259c26d015740a5452f2a3e4426ffa0a3567fe58`，定向修复 `eecf79ada503e64e2fbf0406bc23a1415a6059f5` 已释放 writer。
- 父正常整合 main `3d5fa20a4c3e4e4e2c1ab42e46f6f2c4b81235b5` 得 `1763d64202da63e0192f9783a0f7521be60c66dc`，随后由父唯一 writer 接线。最终候选以 PR head 为准。
- 原子任务 `node:delegated-task:command%3Amcp%3A1b245de5-ec9a-4684-9829-ec78b93c5e5e%3Adelegate-task%3Astage1-yuk1568-shared-submit-intx-swe2-max-214-20261021`，协调登记 YUK-1568 评论 `4528709`。
- 父接 `src/server/questions/submit-question.ts` 与 `src/capabilities/practice/server/tools/submit-question.ts`；另两 held `parts.ts`/`draft-contract.ts` 不需改动。不触 provider、questions/write.ts、embedding 或旧父树。

## 实际产品行为

声明候选原先依次 save、submit、最后单独写候选回执。现在由 `persistDeclaredQuestionGroup` 统一管理调用方 claim、身份绑定、草稿保存、根行和真实子行、唯一发布口、verify outbox、域回执和候选 canonical 回执，在同一个事务内提交。调用方只提供声明、来源注入和终态映射，不负责排内部写入顺序。提交成功后才 drain verify；失败保留 durable intent，不重入生成。

- `edit-question.ts`：既有完整 save 事务体成为 `saveDraftEditInTx`；原 `saveDraftEdit` 外部签名保留，事务外转换 `TxAbort`。save 回执 envelope 不新增 task_run_id。
- `shared-submit.ts`：唯一 submit 事务内核与声明组合入口。旧无 producer 请求指纹字段集保持不变；producer 仅承载确定性组 id 和是否物化子行，来源、归因、难度、URL claim、供给信息仍由 `sourced` 权威提供。
- `submit-decision.ts`：迁移原来的契约转换屏障、准入判定、判分层保留、展示推导、来源和近似去重。#1935 已合注释随职责迁移。
- `typed-group.ts`：新组声明的身份绑定和真实 child 投影。单 part 的 groupId 等于绑定 part_id；多 part 有根及每 part 一条真实 question 行，不造 part__unit 伪子行，不逐 child 重发布。
- `submit-question.ts`：既有提交事务边界保留；内核只接受 Tx，普通 API 负责 commit/rollback 后返回和 drain。
- Practice 工具：现役 declared 分支消费完整组合入口；原 flat 路径和阶段性候选校验保留。外层最终回执在锁内复查，不能覆盖已经原子提交的候选回执。向量输入戳和可观测 canary 仍在 commit 后 best-effort；其失败不会重放已提交业务。

## 身份、回滚与重放

- part/material/unit 在文档内唯一；slot 按 part，option/criterion 按 unit。作用域键使用 JSON `[scope, local]`，避免斜杠分隔符碰撞；字典无 prototype，任意合法字符串不会隐式命中对象属性。key 与 blank_order 只解析所属作用域，不根据内容猜绑定。
- namespace 来自原 candidate request_id，save/submit 仍用 `:save`/`:submit`。canonical taskRunId 不换成实际日志 run id。旧回执保持不变。
- 锁序：调用方 request → save request → submit request → 既有域锁。candidate 回执与业务同 commit，重复同指纹返原回执，异指纹拒收。
- `duplicate_source`/`duplicate_exact` 等已完成去重的业务冲突提交其 KC merge、URL release 和冲突回执，保留可修草稿。
- 发布口在行投影之后拒绝时抛 `SubmitTransactionAbort`，最外事务回滚后才转 conflict；save 的 `TxAbort` 同样在事务外转换。projection/DB 异常继续抛出。不能把以上异常在事务内部吞掉而留下半个根/子行。
- unpublished withheld 是合法存储终态：保留草稿 ref/version、原因与 issues，不宣称可出。

## #1925 整合保护

未合 #1925 固定 `23e103b82ed7b80dac50379d11f3df2481e4fc24` 的工具 diff 独立封存于仓库外 `review/stage1-yuk1568-s3-intx-20261021/integration-protection.json` 及相邻源码/patch。其源码 SHA `270e1a43bbc17364bd4b12ca8664ab881bab7e5d5a5346d3732a6787c414cf45` 与当时 main 工具 SHA 不同，原因是未合 PR 的实质差量，不是清单录制时点错误。

本片不整体合入未合的 #1925。后合的一方按实际 main 逐 hunk 保留：

- sourcing_web 且 logTaskRunId 存在时，created_by 归 SourcingTask 的真实 run；其余 fallback 保持。
- candidate 和 declared 成功事件的 difficulty_reason 与 `task_run_id=logTaskRunId??taskRunId` 均保留。
- request/claim/paid/verify 的 canonical taskRunId 不替换。发布后事件失败不得驱动重放。

## 深模块与机器门

完整事务职责有现役工具 consumer；不另建 registry，不增加跨 capability 值依赖或 capability→server 边。submit 原 1175 行的判定、投影和事务分别归完整模块，新文件均小于1500行。

工具从1247到1292行的增长是原子回执终态映射，已评估拆分：声明持久化已移到完整内核，来源注入与候选输出留原工具，避免新入口和额外 server 边。edit/shared/tool 的 sourceSizeRecords 仅登记实际大小和职责理由。

现行架构门发现原 facade 的新转出；无外部 consumer 的 runAdmissionChecks 与类型已删，剩 canonicalJson、deriveKind、claimSubmitRequestId、writeSubmitReceiptEvent、persistDeclaredQuestionGroup 五个精确站点已由协调精确裁为 stable_contract；批准工件 coordinator-resume-20261021/k1-five-stable-contract-classification.json，SHA d9ca5adcd999f3cd2e0f7f2e5e18fb80b0e08f8cb2357de717dd69100ae647df。旧 claim/receipt 的 caller 仍掌握锁序，这项残余负担不称已解决；不按文件泛放，不修改审计逻辑。

## 验证和交付触发

子线 eecf 的 tsc/lint/build/schema/boundary/draft-status 记录属于接线前历史。父 frozen install 0，接线后 tsrs 两配置 0；初次边界审计因工具增长与shared大小记录不符失败，已按实测修正；五站点分类已批准，登记后审计待复核。最终 lint/build/audits、独立 R1 与 exact-head CI 待新 head，不能复用旧绿。

下一可验收产物是含实际 declared consumer 的完整 PR。触发条件：父静态门、精确出口分类、R1/既有P0/P1裁决及当前 head GitHub CI Gate。owner 2026-10-21 已取消 last-push/17分钟等待；不为 advisory 新建 timer、等待或重跑，至多 R1+R2 预算不变。

测试/断言（含临时脚本）、DB 重放/并发/回滚、复合组真实 serving、producer actual-output、provider/paid、部署均 NOT_RUN。既有 edit-submit DB case 随公开入口接到内核，但未在本机执行。需要新断言时另报文本方案，测试不作为产品准备前置。

## 后续主交付和运行边界

- K1 后续：按 YUK-1594 已定「统一候选、同门准入」接实际 consumer；不扩独立 QuizGen typed writer。其他生产端与现役复合 serving 的完整验收尚缺，不把本片等同 K1 完成。
- K5 的题目展示/真实发行门持续保留；不依赖 ea21 发布才能继续独立 UI/后端契约开发。任何需要新 K1 typed producer 的复合卷验收明确依赖本片及后续生产端；不推断整卷已验收。
- YUK-1431/ADR-0070 共用判断只读适配在 K1 第三片后；按真实现役版本封存 θ̂/PFA/FSRS，不把已合算法当 owner 批准切换。YUK-1470 切换仍另批。
- ea21 发布：迁移线执行、协调裁资源；下一事件为 appendix/build 资源明确裁定。主线不取运营锁。1629 04/05 负正例已接受，不重复；只剩部署状态。
- 清树/巡检：迁移线按各自授权和活跃绑定处理；本实施树活跃保留，旧 stage1-lead 不写。这些运营事项不阻塞 K1 源码交付，不计作 K1/K5 成果。
