-- YUK-1050 — 历史迁移 apply 执行器的运行账本（grounding §15：分阶段离线可续跑
-- + locks/WAL/duration 观测）。运维工具表，非判分/作答真相：允许 UPDATE（阶段
-- 状态迁移）。备份语义：运维态不进备份（BACKUP_EXCLUDED_TABLES）且 restore 时
-- 先擦除（RESTORE_WIPE_ONLY_TABLES，子 phase 先于父 run）。
-- 由 drizzle-kit generate 从 schema.ts 声明生成（CHECK/FK/索引与声明一致）。
CREATE TABLE "migration_apply_phase" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"phase" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"wal_lsn_start" text,
	"wal_lsn_end" text,
	"rows_written" integer DEFAULT 0 NOT NULL,
	"rows_already_present" integer DEFAULT 0 NOT NULL,
	"error" text,
	CONSTRAINT "migration_apply_phase_status_ck" CHECK ("migration_apply_phase"."status" IN ('running','completed','failed','skipped')),
	CONSTRAINT "migration_apply_phase_name_ck" CHECK ("migration_apply_phase"."phase" IN ('preflight','plan','apply_mappings','apply_submissions','reconcile')),
	CONSTRAINT "migration_apply_phase_rows_ck" CHECK ("migration_apply_phase"."rows_written" >= 0 AND "migration_apply_phase"."rows_already_present" >= 0)
);
--> statement-breakpoint
CREATE TABLE "migration_apply_run" (
	"run_id" text PRIMARY KEY NOT NULL,
	"checkpoint_hash" text NOT NULL,
	"classification_hash" text NOT NULL,
	"classification_version" text NOT NULL,
	"registry_digest" text,
	"plan_digest" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"wal_lsn_start" text,
	"wal_lsn_end" text,
	"error" text,
	CONSTRAINT "migration_apply_run_status_ck" CHECK ("migration_apply_run"."status" IN ('running','completed','failed'))
);
--> statement-breakpoint
ALTER TABLE "migration_apply_phase" ADD CONSTRAINT "migration_apply_phase_run_id_migration_apply_run_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."migration_apply_run"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "migration_apply_phase_run_phase_uq" ON "migration_apply_phase" USING btree ("run_id","phase");