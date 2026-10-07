# YUK-1363 — 独立测试附件存储

2026-10-07：本机 Agent 测试环境已恢复附件上传、读取、删除。此次仅调整运行配置，app/worker 仍固定 `f3bfff2cf`，没有再次清库、执行迁移或恢复私人数据。YUK-1364 的 TeachingBrief 修复独立推进。

## 部署

- 官方 SeaweedFS `4.48`，ARM64，镜像固定为 `ghcr.io/chrislusf/seaweedfs@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d`。来源及发布方式见[官方 Docker 文档](https://github.com/seaweedfs/seaweedfs/blob/4.48/docker/README.md)。本机没有 cosign，未声称完成签名校验。
- 专用卷 `the-learning-project_agent_test_assets_20261007`，专用 internal 网络 `the-learning-project_agent_test_storage`，bucket `tlp-agent-test`。没有映射主机端口；管理组件仅监听容器 loopback，关闭 Iceberg/Lance 服务。
- app/worker 的 `R2_ENDPOINT` 指向 `http://test-storage:8333`，使用新生成的测试凭据。私人 R2 和 Tunnel 凭据没有重新加入。
- S3 沿用现成客户端的 `region:auto` 和 path-style；没有新增业务存储适配器或自研服务。
- 容量配置为最多 16 个 volume（每个目标 1024 MB，并非文件系统硬配额）；附件 bucket 和内部元数据日志共用此上限。最初 4 个 volume 不足以容纳元数据日志，独立复核发现后已修正。当前实际磁盘占用很小，仍须监控 Docker 所在磁盘；本机存储没有对象云服务或模型调用费用。
- SeaweedFS 数据和 filer 元数据都落在 `/data` 持久卷。app/worker 的 Compose 启动依赖存储 healthcheck；实际 S3 鉴权/内容正确性由下述验收证明。

私有运行目录为 `/Volumes/YukovalSBak/yukoval-projects/tlp-local-prod-20260907.sjUaCU/deployment-test-storage-20261007`。`compose.local.private.json` 和 `s3.private.json` 含凭据，不提交仓库。唯一当前入口由其上级 `current-release.json` 指定，运维先核对该文件和独占部署锁。

## 实际验收

切换前，同一张 64×48、8237 字节的合成 PNG 上传返回 HTTP 500，`source_asset` 无记录。

切换后通过真实 `/api/assets` 路由：

- 同一 PNG 上传两次均 201，得到不同记录、相同 storage key；读取 200，字节 SHA-256 与输入一致。
- 删除第一条返回 200，读取该条 404；第二条仍可读取且内容一致，证明共享对象未被提前删除。
- 删除最后一条返回 200，读取及再次删除均 404；SQL `source_asset` 数量为 0，S3 bucket 列举对象数量为 0。
- 不支持的 MIME 上传返回 400。
- 直接 S3 写入后强制重建存储容器，读取字节一致；删除后 HEAD 404。错误凭据及匿名访问均 403。
- app/worker healthy；`/api/ready` 返回 `assessment-contract-v1 / active`。

证据在私有运行目录的 `evidence/`：`asset-acceptance.json`、`s3-persistence-auth.json`、`s3-empty.json`、`source-asset-count.txt`、`storage-image.json`；`release-result.json` 汇总验收。图片由确定性脚本生成，没有调用图像模型或其他产品模型。

## 恢复边界

本次保留旧配置副本和切换前测试库 dump；未修改数据库结构或业务数据，也未把这份额外 dump 宣称为完成恢复演练的新恢复点。YUK-1362 已验证的旧私人备份继续离线保留，禁止自动恢复。

存储故障时先保留当前数据库和对象卷；旧无 R2 配置只会恢复“附件不可用”的状态，不可作为完整附件回退。此后如果生成需要保留的测试附件，恢复必须将 PostgreSQL 的 `source_asset` 与同一时点的对象卷配对，不能只恢复其一。

当前仍是 `agent-development-test`，不具备日用部署承诺。用户明确说“为我日常使用的部署”之前，不切换用途。

独立只读复核未发现 P0/P1。复核提出的 volume 数量不足与最终配置重建证据缺口均已修正；12:08Z 最终配置下再验持久化、鉴权和完整 API CRUD 通过，容量报错消失。最终证据为 `asset-final-acceptance.json`、`s3-final-persistence-auth.json`；部署锁已释放。
