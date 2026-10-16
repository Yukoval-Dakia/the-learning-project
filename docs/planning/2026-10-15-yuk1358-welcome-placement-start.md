# 第一天能用：欢迎与定位的 Start 入口

审计根项：Stage 1 B8/M1，YUK-1358。主线授权只迁入口，复用现有组件与 HTTP 默认客户端；不是完整 RPC 迁移，也不是首次定位/真实判分验收。

## 行为与范围

- 直接打开 `/welcome`、`/placement` 由 Start 显式路由负责，经过既有 TokenGate 和 StartWorkbenchShell。
- 旧 SPA 生产导航以既有 beforeLoad document replace 转交 Start；预加载不跳转。DEV 保留旧渲染。
- 组件、目标创建、定位恢复/提交/退出、领域逻辑、视觉及 API 鉴权不改。导航查询值与 hash 保留；URL 编码可由路由器规范化。
- 四个产品文件：两个新 route、生成的 routeTree、SPA router 两项。没有新增 useEffect 或测试代码。

## 源码验证

基线 `bb5c24824`；初审源码 `8794ce105`，后续 `4d5d3fe79` 仅格式调整。GLM 5.3 max 独立 R1：NONE，范围为这四文件及 auth/query/session/exit 导航链，纯静态，不代表浏览器或真实判分通过。

父 `pnpm build`、`pnpm typecheck`、最终 `pnpm lint` exit 0（lint 继承 172 warnings）。首次 lint 仅本次 PlacementRoute 换行错误，保留 `/tmp/yuk1358-f1-lint.log`，已格式修正。

## 真实隔离页面观察

2026-10-15 使用协调者批准的 `ui-loft-restore` / `ui-loft-storage`，唯一临时候选 app `tlp-f1-candidate-app`，127.0.0.1:8818。复用当时 TEST image `sha256:1be52c3e0332555fd3cc9aba0b90797601009d7855f90c274ece9a97c22806fb` 依赖，完整只读挂载本树 dist 与 web/dist；无 worker、provider key 为空。仅登录及读取副本，不创建目标/定位会话、不提交题目。

| 实际输入 | 观察 | 限度 |
| --- | --- | --- |
| 未登录 `/welcome` | 令牌 gate；`/api/subjects` 401、health 200 | 未改变鉴权 |
| 候选专用令牌登录 `/welcome` | 原欢迎页；真实 subjects GET 200，显示语文/数学/物理 | 未提交 goal |
| `/placement?source=f1#resume` | 原页面「还没设定目标」 | 未验证有 goal/session 的恢复或判分 |
| 旧 `/profile` SPA 内 History/PopState 导航至 `/welcome?source=legacy%20nav#preserved` | 新 document timeOrigin，脚本由 `/assets/` 转 `/_build/`；欢迎页显示，query 值与 hash 保留（空格编码为 `+`） | 程序化浏览器导航，不冒称点击或创建目标 |
| 旧 SPA 转 `/placement` | T3 evaluate/snapshot 连续超时 | 未计通过；后续线程发送也出现 MCP HTTP connection failure，不能据此判定产品根因 |

截图留在浏览器 artifact，路径见 evidence JSON。页面已有外部字体被 CSP 拒绝日志，未改 CSP/字体，不宣称本片修复。首次父启动检查误以为隔离 DSN host 必为容器名，实为该容器已配置的 `postgres` alias；核对网络 alias 后显式指向隔离容器继续，没有创建第二个 app。

## 清理与交付边界

窗口总 337.405 秒，22:33:16 JST 核 owner/token 后释锁。唯一候选 app 已停止删除；获批 restore/storage 停止保留；旧容器 ID 集合、其余容器 image/start/status/health/ports 及 current-release 均一致。首次清理比较误包含滚动 Health.Log，拒绝释锁；父逐字段确认仅健康探针日志变化后按稳定状态复核，原失败与最终回执均保留。

证据 `/tmp/yuk1358-f1-browser-20261015/`。没有部署 TEST，后续合并须 exact-head CI 与 match-head；上述未验证项仍属 YUK-1358，不能以本片关闭整票。

## 最新 main 组合

正常合入 `797cf17bf`（仅 package/lock 两项开发依赖更新）后，frozen install、typecheck、lint、build 全部 exit 0。日志 `/tmp/yuk1358-f1-final-{install,typecheck,lint,build}.log`。路由产品与原 R1 相比只有格式调整；浏览器证据仍标记为依赖合入前的构建，不倒推为新依赖已实测。
