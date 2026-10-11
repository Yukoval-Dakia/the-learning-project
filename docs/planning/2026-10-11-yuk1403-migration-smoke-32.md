# 第一天能用：迁移 smoke 审计清理

Audit root: YUK-1403 的测试准入审计；源码依赖 #1625 已合入 `148cf4bd66cc0bf451fb2b4a1532e7187a3283c9`。

从审计原件 `tlp-audit-artifacts/yuk1388/yuk1403/case-inventory.jsonl` 精确选择文件 `tests/integration/migration-smoke.test.ts`、kind=`it`、decision=`drop` 的 32 个 AST case。使用 describe 路径和完整 case 名称匹配，不使用旧行号，也不包含另一个 native-pi-config 文件的四项。

原文件识别 65 个 case，删除 32 个，保留 33 个。保留 case 的完整函数文本逐项相同；参数化用例按一个 AST case 计，不冒称运行用例总数。删除两个已无 case 的 describe 及其私有 setup/teardown，避免无测试容器开销。其他套件的 setup/teardown 和保留 case 不变。

映射和审计理由见 `docs/planning/evidence/2026-10-11-yuk1403-migration-smoke-32.json`。原始文件副本保留在 `/tmp/yuk1403-migration-smoke-before.ts`，基线也保留在 Git。

GLM 与 SWE-2 的委派分别因额度失败，未写入源码；父级完成本次 AST 清理。依赖通过离线 frozen-lockfile、ignore-scripts 安装，未改变 lockfile。初次空套件脚本因 /tmp 相对 require 失败，没有修改文件；修正模块路径后成功。

验证状态：单文件 Biome、typecheck、lint、build 均通过，日志在 `/tmp/yuk1403-smoke-{biome,typecheck,lint,build}.log`。DB/container/runtime/provider 未运行，独立审查和 exact-head CI 未完成。此测试清理不是 provider 验收；历史 429 与未知 pre-budget 费用不变。
