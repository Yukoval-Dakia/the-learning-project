# 第一天能用：欢迎与定位的 Start 入口

审计根项：Stage 1 B8/M1，YUK-1358。主线授权只迁入口，复用现有组件与 HTTP 默认客户端；不是完整 RPC 迁移，也不是首次定位/真实判分验收。

## 行为与范围

- 直接打开 `/welcome`、`/placement` 由 Start 显式路由负责，经过既有 TokenGate 和 StartWorkbenchShell。
- 旧 SPA 生产导航在这两个入口用 beforeLoad 的 replaceState + reload 转交 Start；预加载不跳转。DEV 保留旧渲染。
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

## 2026-10-16 导航缺陷修复与证据更正

`4ee1fa3a5` 隔离复核确认旧 SPA → placement 停在 RoutePending，旧 timeOrigin/assets 未变，属于真实导航缺陷。失败窗口 `/tmp/yuk1358-f1-placement-recheck-20261016/` 保留。

修复 `7fbfb860a` 只给 welcome/placement 使用 `history.replaceState` 写入目标 href，再 `location.reload()` 强制新 document；预加载跳过，其他迁移入口不改。最终 GLM 5.3 max R2 NONE（静态），本地 typecheck/lint/build exit 0。Start 入口已挂；嵌套调用仍走 HTTP。

同修复头的真实旧 questions → placement：timeOrigin 从 1792140692570.1 变为 1792140740795.4，脚本从 `/assets/index-CVC2LnCd.js` 变为 `/_build/assets/index-C_-veGUm.js`，目标 `/placement?source=legacy+nav&pace=light#preserved`，DOM 显示「还没设定目标」。该窗口总 283.549 秒，protected/all-ID/release parity 全 true，候选已删、副本停止、锁已释放。

welcome 的完整 before/after 记录仍未闭合：最后一次 evaluate 在文档切换时返回 `Inspected target navigated or closed`，父随后过早清理，未捕获稳定 after。保留原错误，不能计通过。额外补验原子取锁遇 UI 窗口而 exit 75，零容器操作；协调线随后明确当前无 runtime 授权，后续需重新申请窗口。

工具限制：`preview_type` 曾报告成功但输入仍为空；部分截图为黑图。截图工具失败不作为产品通过或失败，DOM/URL/timeOrigin 证据单列。导航 observations 与 cleanup 的路径/hash 见 evidence JSON。

PR 旧头 `4ee1fa3a5` 的 CI contracts 失败只来自 knowledge_edge 五项 expected_by 过期；#1732 已由主线合入 `cc5c49dc7`。本片正常合入该 main，不自行修改白名单。新组合的浏览器验收仍未执行，不倒推旧证据。

组合 `5e6027264` 的 typecheck/lint/build 全部 exit 0，日志 `/tmp/yuk1358-f1-1732-{typecheck,lint,build}.log`；随后只有本交付文档与证据更新。
