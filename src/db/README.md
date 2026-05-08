# db

Drizzle schema —— SQLite dialect（跨 PWA / Tauri / D1 一致）。

## 运行时 driver 路线

| Phase | 驱动 | 持久化 |
| --- | --- | --- |
| 1 (PWA) | `@sqlite.org/sqlite-wasm` + `drizzle-orm/sqlite-proxy` | OPFS |
| 3 (Tauri) | `tauri-plugin-sql` 或 `better-sqlite3` | 本地文件 |
| 4 (云同步) | `drizzle-orm/d1` | Cloudflare D1 + R2 |

## 迁移

```bash
pnpm db:generate   # schema diff → ./drizzle/*.sql
```

迁移文件提交进 git，运行时按版本顺序 apply。

## JSON 字段约定

数组 / 对象一律 `text({ mode: 'json' })`，drizzle 自动 `JSON.parse`。**不**做关系展开（如知识点 join 表）—— 自用规模直接用嵌套 JSON 更省事，真要查再加索引或 view。
