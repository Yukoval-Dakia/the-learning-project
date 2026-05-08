// Drizzle client —— driver 待接入。
//
// Phase 1 (PWA)：OPFS-backed `@sqlite.org/sqlite-wasm` + `drizzle-orm/sqlite-proxy`。
// Phase 3 (Tauri)：tauri-plugin-sql 或 better-sqlite3 直连。
// Phase 4 (云同步)：Cloudflare D1 镜像（`drizzle-orm/d1`）。
//
// 当下导出 schema 让 drizzle-kit 能从 schema diff 生成 SQL 迁移；运行时连接在下一步加。

export * as schema from './schema';
