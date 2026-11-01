# paused_at 历史兼容保留

2026-11-01，YUK-1113。依据[精确批准](https://linear.app/yukoval-studios/issue/YUK-1113#comment-90cdbc23-19b1-44bd-8026-9c085bbbb803)。

退场的是未实现的 pause/resume timestamp producer 承诺。没有新暂停功能；
`status='paused'` 的运行门不变。此决定不关闭本票其它预留字段职责。

## 数据与兼容

- 原 `event_subscription_checkpoint.paused_at` nullable timestamptz 物理列、
  Drizzle property/SQL 名、timezone 和无 default 定义保持。无 DDL、迁移、回填或数据清理。
- `archive.ts` 原 `select *` 导出、`getTableColumns` 白名单、wipe 前字段校验和
  按归档 keys 恢复的路径保持。非 null 历史值和 null 均保留；不假设真实数据库中是否有值。
- 两个既有 fixture 和类型化备份恢复断言全文保持；未通过删除 ORM 字段让审计或备份漏列。
- 原历史恢复是复制已有归档，不是该列的业务 producer。没有按文件名授予业务写入豁免，
  新业务 caller 不能通过名为 restore 的函数获得豁免。

## 固定单列合同

`audit-schema-writes.ts` 对该列使用固定、无到期日的历史保留合同，结果仍显式展示
`historical-retained`。它要求唯一的原 SQL 列/property、timezone timestamp、nullable、
无 default；删列、改名、类型漂移、重复声明或链式 default/notNull 改动均失败。

原 production write index 正常建立；该目标的 Drizzle payload 必须可检查，
业务 INSERT/UPDATE 含 `paused_at`（包括 null/default）失败，未知 payload 和无列清单
也不能作为保留证明。补充识别直接执行 SQL 中该固定表的双引号标识符，仍经原 SQL
producer scanner 解析。没有目录排除或通配写豁免，其它 checkpoint 字段仍正常审计。
这是静态语法边界，不是任意动态 SQL 的全程序证明，也没有修改数据库写权限。

只有合同存在时才删除该列 dated allowlist。expiry 算法、退出码、其它历史表合同均保持。
五条已有生产写入的陈旧豁免同时退出：`intervention.outcome`、`question.source_ref`、
`question.created_by`、`learning_item.source_ref`、`learning_item.primary_artifact_id`。
其业务列、生产写入和 reader 均未改变。

## 验证边界与解除条件

新测试 TEXT 未获批准，未新增/修改测试；旧 fixture 存在不代表备份恢复已实测。
本地只执行现行静态门；所有 tests、DB、provider、runtime、迁移、备份实际执行均 NOT_RUN。
独立原预算审查与 exact-head CI 仍需分别满足。实际合入后，受阻功能 PR 才能正常组合
这项共享修复并取得自身 Gate；批准或单项 schema 绿不替代其其它失败项。
