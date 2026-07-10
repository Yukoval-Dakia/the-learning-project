-- YUK-599 (YUK-597 v3 trait 合同 §2.2/§6) — subject 控制面六表族 + 公共全序序列。
-- 零行为变化地基：本 migration 只建结构；种子行由 migrate 尾的
-- reconcileBuiltinTraits 条件写入（seed_version 相等整行跳过 → 重跑零副作用），
-- 不在 DDL 里 INSERT。
-- 两本 journal 的 change_seq 共用全局序列 subject_change_seq（exact as-of 重放轴）；
-- restore 尾必须 setval（序列不随行备份）。
CREATE SEQUENCE IF NOT EXISTS "subject_change_seq";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subject" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"display_name_norm" text NOT NULL,
	"origin" text NOT NULL,
	"is_selectable" boolean DEFAULT true NOT NULL,
	"retired_at" timestamp with time zone,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subject_display_name_norm_live_custom_uq"
	ON "subject" ("display_name_norm")
	WHERE origin = 'custom' AND retired_at IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subject_trait" (
	"id" text PRIMARY KEY NOT NULL,
	"trait_kind" text NOT NULL,
	"origin" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_schema_version" integer NOT NULL,
	"seed_version" text,
	"owner_subject_id" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subject_trait_kind_idx" ON "subject_trait" ("trait_kind");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subject_trait_journal" (
	"trait_id" text NOT NULL,
	"revision" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_schema_version" integer NOT NULL,
	"seed_version" text,
	"action" text NOT NULL,
	"actor" text NOT NULL,
	"source_trait_id" text,
	"source_revision" integer,
	"rolled_back_from" integer,
	"change_seq" bigint DEFAULT nextval('subject_change_seq') NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "subject_trait_journal_trait_id_revision_pk" PRIMARY KEY ("trait_id", "revision")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subject_trait_binding" (
	"subject_id" text NOT NULL,
	"trait_kind" text NOT NULL,
	"trait_id" text NOT NULL,
	CONSTRAINT "subject_trait_binding_subject_id_trait_kind_pk" PRIMARY KEY ("subject_id", "trait_kind")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subject_trait_binding_trait_idx" ON "subject_trait_binding" ("trait_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subject_control_journal" (
	"subject_id" text NOT NULL,
	"revision" integer NOT NULL,
	"action" text NOT NULL,
	"detail" jsonb NOT NULL,
	"actor" text NOT NULL,
	"change_seq" bigint DEFAULT nextval('subject_change_seq') NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "subject_control_journal_subject_id_revision_pk" PRIMARY KEY ("subject_id", "revision")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subject_name_claim" (
	"name_norm" text PRIMARY KEY NOT NULL,
	"subject_id" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subject_name_claim_canonical_uq"
	ON "subject_name_claim" ("subject_id")
	WHERE kind = 'canonical';
