-- YUK-1007 — 热加载配置面三表（docs/planning/2026-09-26-yuk1007-hot-reload-config.md §1）：
-- per-key system_config + append-only system_config_journal（(key,revision) PK，
-- change_seq 走独立序列 config_change_seq——不复用 subject_change_seq，两域独立）
-- + 单行失效轴 system_config_epoch（id='global'）。restore 尾 setval 惯例见
-- archive.ts（序列不随行备份）。
CREATE SEQUENCE IF NOT EXISTS "config_change_seq";
--> statement-breakpoint
CREATE TABLE "system_config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"source_note" text,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_config_epoch" (
	"id" text PRIMARY KEY NOT NULL,
	"epoch" bigint NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_config_journal" (
	"key" text NOT NULL,
	"revision" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"action" text NOT NULL,
	"actor" text NOT NULL,
	"change_seq" bigint DEFAULT nextval('config_change_seq') NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "system_config_journal_key_revision_pk" PRIMARY KEY("key","revision")
);
