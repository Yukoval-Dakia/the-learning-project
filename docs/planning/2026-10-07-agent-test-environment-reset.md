# Mac Agent 测试环境重置记录

日期：2026-10-07。跟踪：[YUK-1362](https://linear.app/yukoval-studios/issue/YUK-1362)。

## 用途

Owner 明确要求清空当前本地部署数据库并重新部署，仅供 Agent 开发测试。迁移、UI 重写和其他改进完成后，仍须等待 owner 明确要求“为我日常使用的部署”才切换为日用。此次清空授权不构成以后任意删库的授权。

入口仍为 `http://localhost:8787`。没有改变 UI，也没有把测试数据解释为 owner 的学习状态。原自动运维任务的提示已更新用途，保持原来的 disabled 状态。

## 已执行

- 唯一操作线程为 `7631c12b-ff58-44b3-aee5-303edfdfd42c`。操作前取得当前 release 指向的部署互斥锁，并通知原自主交付线程。
- 固定原已部署提交 `f3bfff2cfe2aea0efbf7d11ead8a84ebfab497ef`，运行镜像 ID 为 `sha256:e681a7b502aa6a370b572edfb3ebef7a559c8d09df841d4e7361838598d2fbb1`。没有部署 PR1584、PR1588 或其他候选镜像。
- 停止主 app 和 worker，确认没有其他 `loom` 数据库客户端，备份完整 PostgreSQL 业务库和 Mem0 SQLite 历史。隔离容器恢复备份后，101 张表的计数与原库一致，SQLite 完整性检查通过。
- 在隔离空库验证同一镜像的全部 115 项迁移，依次执行 contract epoch 的 prepare、ready 和 activate。空库 health、readiness、brief、probes 接口通过。
- 删除并重新创建主数据库 `loom`，包括其所有业务、队列、向量和迁移 schema。重新运行 115 项迁移并激活 `assessment-contract-v1`。
- app、worker 均重新创建，标记 `tlp.environment=agent-development-test` 和 `tlp.personal-daily-use=false`。worker 使用全新 Mem0 卷 `the-learning-project_agent_test_mem0data_20261007`，未挂载旧历史卷。
- 新 app、worker 移除了旧私人 R2 和 Cloudflare Tunnel 凭据。云端旧附件没有删除。独立验收容器、其他数据库和工作树没有清空。

## 验证结果

重部署后 app 和 worker 均 healthy，worker 已注册 handlers。`/api/health`、`/api/ready`、`/api/prep-desk/brief`、`/api/prep-desk/probes` 和 `/api/copilot/sessions` 均返回 200。

Brief 为 `null`，probes 和 sessions 为空。question、assessment_submission、ai_task_runs、provider_attempt 均为零。event 中只有迁移生成的三条系统 knowledge genesis。数据库还包含内置科目、traits、迁移和运行时初始化记录，因此“清空”不表示迁移后每张表都为零。

Mem0 新卷没有历史文件。没有发起模型请求。此次验证覆盖重置、恢复、空库迁移和运行接口，不代表评分质量、迁移项目、UI 重写或个人日用验收完成。

## 保留的证据与限制

私有运行根为 `/Volumes/YukovalSBak/yukoval-projects/tlp-local-prod-20260907.sjUaCU`，本次目录为 `deployment-agent-test-20261007`。其中 `backup/` 保存 PG dump、Mem0 archive、计数和摘要；`evidence/` 保存恢复计数、清空前后数据库 OID、迁移和 epoch 日志；`release-result.json` 保存接口和数据验收。根目录 `current-release.json` 指向本次部署，`environment-purpose.json` 记录用途和日用切换条件。私有 Compose 含凭据，不提交仓库。

旧数据备份和旧 Mem0 卷离线保留，不自动恢复或重放。原 failed/DLQ 历史已随本次明确授权的清库退出运行环境，其完整历史仍在 dump 中。清库不表示此前判题、重试或保留策略缺陷已修复。

独立测试附件存储尚未配置，因此当前附件上传不可用。尝试取得独立 S3 测试服务镜像时，镜像源返回访问或传输错误，未回退到私人 R2。此限制纳入 Linear 后续，不能宣称完整附件流程通过。

操作期间 OrbStack 因系统盘 ENOSPC 停止。系统空闲空间回升后恢复 OrbStack，随后重新停止主 writer 进行备份。未执行磁盘清理，也未主动恢复其他线程的候选容器。

原 TeachingBrief 故障已定位为展示层没有过滤无正式 issuance 的旧 canary 题。重置移除了这批旧数据，但后续仍需对齐 TeachingBrief 与正式判题准入条件。
