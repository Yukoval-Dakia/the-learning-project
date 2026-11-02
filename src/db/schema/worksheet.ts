// Worksheet PDF export: export batches, items, and frozen region map pages.

import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { assessment_issuance } from './assessment';

type JsonObject = Record<string, unknown>;

// ====================================================================
// YUK-1523（P5）— 作答卷 PDF 导出：发放绑定、页面身份与冻结区域图。
//
// 三表契约（docs/design/2026-10-11-worksheet-print-layout.md，#1693 合并版）：
//   - worksheet_export：一次导出 = 一次发放批次。export_token（不可猜）+
//     短码是页面身份码 tlp://ws/v1/<token>/<页>/<总页> 的锚；idempotency_key
//     唯一，同 key 同 request_digest 重放不重发；refused 冻结门拒绝清单
//     （G4 只导可判题，拒掉的题不发不导）。web_only_units/page_count/
//     archived_at 在区域图存档时一次写入（write-once：archived_at 置位后
//     不再变更）。
//   - worksheet_export_item：导出绑定的冻结题目清单（有序）。issuance_id
//     外键指向 assessment_issuance（发放行不可删，ON DELETE 保持 no action；
//     container_occurrence_ref='worksheet:<export_id>' 把发放事件与导出对上）。
//   - worksheet_region_map_page：界面线渲染器与 PDF 同一渲染 pass 量出的
//     区域图，按页冻结存档（write-once：PK (export_id, page) 只 INSERT；
//     同 digest 重 POST 幂等，异 digest 409）。map_digest 是 canonical 串化
//     的 sha256，用于幂等比对；region_map 是已过后端校验（对冻结发放：
//     每区域引用已发 part/slot、每计分单元恰一着落、选项圈与冻结
//     option_order 一致）的页级切片。
// ====================================================================

/** 一次导出中被服务门（G4）拒绝、未导出的题，及其 typed 原因。 */
export type WorksheetRefusedItem = {
  group_id: string;
  status: string;
  serving_reason:
    | import('../../core/schema/assessment/serving-admission').ServingUnavailableReason
    | null;
  issues: string[];
};

export const worksheet_export = pgTable(
  'worksheet_export',
  {
    export_id: text('export_id').primaryKey(),
    /** 卷面来源标题（页头「来源」；空串允许，渲染器回退默认）。 */
    title: text('title').notNull().default(''),
    /** 页面身份码锚：不可猜随机（base64url，≥160 bit 熵）。 */
    export_token: text('export_token').notNull(),
    /** 人读短码（如 TLP-7K2Q）；卷面印刷，只给人看。 */
    short_code: text('short_code').notNull(),
    /** 调用方幂等锚；同 key 同 request_digest ⇒ 重放，异 ⇒ 409。 */
    idempotency_key: text('idempotency_key').notNull(),
    request_digest: text('request_digest').notNull(),
    /** 门拒绝清单（冻结于创建时；重放原样返回）。 */
    refused: jsonb('refused').$type<WorksheetRefusedItem[]>().notNull().default([]),
    /** 区域图存档时冻结的 web_only_units（存档前为 NULL）。 */
    web_only_units: jsonb('web_only_units').$type<string[]>(),
    /** 区域图存档时冻结的总页数（存档前为 NULL）。 */
    page_count: integer('page_count'),
    /** 与区域图同一渲染 pass 产出的 PDF digest（设计 §4；存档前为 NULL）。 */
    pdf_digest: text('pdf_digest'),
    archived_at: timestamp('archived_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('worksheet_export_token_uq').on(t.export_token),
    uniqueIndex('worksheet_export_short_code_uq').on(t.short_code),
    uniqueIndex('worksheet_export_idempotency_key_uq').on(t.idempotency_key),
    check('worksheet_export_request_digest_ck', sql`${t.request_digest} ~ '^sha256:[0-9a-f]{64}$'`),
    check(
      'worksheet_export_identity_nonempty_ck',
      sql`${t.export_token} <> '' AND ${t.short_code} <> '' AND ${t.idempotency_key} <> ''`,
    ),
    // 存档列 write-once 形状：总页数只在存档时出现；存档必须同时冻结总页、
    // web_only_units 与 PDF digest（对账字段成对落，不允半档）。R2 P2：存档侧
    // 显式 IS NOT NULL —— 正则对 NULL 求值为 NULL，NULL OR FALSE 会穿过 CHECK。
    check(
      'worksheet_export_archive_shape_ck',
      sql`(${t.archived_at} IS NULL AND ${t.page_count} IS NULL AND ${t.web_only_units} IS NULL AND ${t.pdf_digest} IS NULL) OR (${t.archived_at} IS NOT NULL AND ${t.page_count} >= 1 AND ${t.web_only_units} IS NOT NULL AND ${t.pdf_digest} IS NOT NULL AND ${t.pdf_digest} ~ '^sha256:[0-9a-f]{64}$')`,
    ),
  ],
);

export const worksheet_export_item = pgTable(
  'worksheet_export_item',
  {
    export_id: text('export_id')
      .notNull()
      .references(() => worksheet_export.export_id),
    /** 卷面序（0-based，导出请求顺序）。 */
    position: integer('position').notNull(),
    group_id: text('group_id').notNull(),
    issuance_id: text('issuance_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.export_id, t.position] }),
    index('worksheet_export_item_issuance_idx').on(t.issuance_id),
    foreignKey({
      columns: [t.issuance_id],
      foreignColumns: [assessment_issuance.issuance_id],
      name: 'worksheet_export_item_issuance_fk',
    }),
    check('worksheet_export_item_position_ck', sql`${t.position} >= 0`),
    check(
      'worksheet_export_item_identity_nonempty_ck',
      sql`${t.group_id} <> '' AND ${t.issuance_id} <> ''`,
    ),
  ],
);

export const worksheet_region_map_page = pgTable(
  'worksheet_region_map_page',
  {
    export_id: text('export_id')
      .notNull()
      .references(() => worksheet_export.export_id),
    /** 页号（1-based）。 */
    page: integer('page').notNull(),
    /** 存档时声明的总页数（每页一致，导出行 page_count 与之对账）。 */
    page_count: integer('page_count').notNull(),
    /** 已校验的页级区域图切片（canonical 化后的 parsed 形状）。 */
    region_map: jsonb('region_map').$type<JsonObject>().notNull(),
    map_digest: text('map_digest').notNull(),
    archived_at: timestamp('archived_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.export_id, t.page] }),
    check('worksheet_region_map_page_ck', sql`${t.page} >= 1`),
    check('worksheet_region_map_page_count_ck', sql`${t.page_count} >= 1`),
    check('worksheet_region_map_page_digest_ck', sql`${t.map_digest} ~ '^sha256:[0-9a-f]{64}$'`),
  ],
);
