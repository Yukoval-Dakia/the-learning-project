# 2026-10-07 本机发布记录（早期 5d738dbc0）

此为早期发布的历史记录。当前生产已升级为 `0f81e198f`，见[MiMo 发布记录](2026-10-07-mimo-local-release-result.md)；下文旧版本和失败不代表当前状态。

现有 Hono / Vite / pg-boss 应用已在这台 Mac 升级。入口为 http://localhost:8787。完整连续学习系统仍未完成，AI 辅导的实际输出验证失败，不能称为整体验收通过。

## 实际制品与检查

- 源码 revision：`5d738dbc012913f294f7b471027314c933996ddb`。
- app / worker image：`sha256:4de3308a0b292e01d7e6470db4be5edaeaa966a959908fc5937f34980943b01b`，tag `the-learning-project-app:5d738dbc0`。
- app、worker 和原 Postgres 容器健康；`/api/ready` 返回 active，数据库115项迁移。原数据库卷和用户数据保留。
- 生产 worker 的受控 echo job `d8ec9063-92e2-4d2f-ac8f-4ac82e26ca91` 已完成。未把验收用学习作答写入生产画像。
- 最终镜像在恢复副本通过发卷、无效作答拒绝、确定性判分、结算和幂等重放；只生成一次生效结算与一次复习状态更新。这是浏览器同源 API 验证，不等于练习页面全按钮路径已通过。
- 实际浏览器检查了今日、练习、录入、管理配置页面。真实 Chrome 能沿用登录直接进入今日页面。

## 恢复与私有运维资料

私有运行目录：`/Volumes/YukovalSBak/yukoval-projects/tlp-local-prod-20260907.sjUaCU/deployment-20261007/`。其中包含凭据的文件不得上传 GitHub 或打印到日志。

已保留旧镜像标签及归档、63个对象的 R2 快照和摘要。先在恢复副本执行最终镜像的完整 migrator，再停止 app/worker，确认其他 DB writer 为零，取得最终 DB、mem0 和队列备份。停写后 R2 清单与快照一致。最终 DB dump 再次在隔离 PG 恢复成功，随后迁移生产，依次恢复 worker 与 app。

证据入口是 `release-result.json`、`final-backup/restore-evidence.json`、`final-backup/r2-verification.json` 和 `evidence/`。旧镜像单独回退兼容性未验证，不得对已迁移数据库直接换回旧镜像；不得自动覆盖生产 DB。私有 Compose 仅管理 app/worker/migrate，禁止运行 `down`、`--remove-orphans` 或 `down -v`。

4个本轮隔离演练容器已停止并保留。部署锁在发布结束后释放；下一次发布须重新原子取得锁，不能复用历史持有者。

## 日用验证暴露的未完成项

1. Copilot 默认选择最近的已结束会话，导致输入和快捷按钮全部禁用。打开对话记录、新建对话后恢复可输入，源码初始化逻辑与浏览器观察一致。应给出可继续的入口并保持历史只读。
2. 合成椭圆学习场景已从真实浏览器提交。运行 `copilot_run_tool_copilot_user_ask_a66faca244c75e855964389e930a7d04429849fa8684613088c36c556c7ff3cc` 使用 `xiaomi/mimo-v2.5-pro`，2026-10-06T15:59:51Z 返回 HTTP402 `insufficient_balance`。没有生成可展示回答，费用未知，未盲目重试。证据为 `evidence/copilot-actual-output-failure.json`。正在核查已提供的 OpenCode Go 接入。
3. 升级前最终备份已存在38条 failed 和38条 DLQ。14条记忆摄取失败发生在旧 worker，升级后保留，归既有 YUK-1042 继续恢复。
4. 每小时 T3 任务已实际唤起原线程；调度器标记 succeeded 只代表派发，不能证明无人值守产品交付已完成。

## 设计与模型选择

完整行为设计与 ADR-0066 作为后续实现依据，目标架构迁移尚未完成。owner 后续要求工作模型使用 OpenCode Go MiMo 2.6 Pro；子任务和调度提示已指定 `opencode / opencode-go/mimo-v2.6-pro`。父线程切换命令有成功回执，但两次随后中断且下一次仍报告 Codex/Astra，未声称父线程已切换。产品内部模型路由尚未迁移；不能把编排器模型选择当成产品配置已经生效。


2026-10-07 范围纠正：上段“工作模型”是当时线程的解释记录。owner 最新明确指的是产品内部 AI 工作，旧开发模型范围解释已作废。产品路由迁移与后续发布状态见 [YUK-1341 产品迁移说明](2026-10-07-yuk1341-product-mimo-routing.md)。本文件的旧制品、失败、备份和部署事实不因此改变。
