-- YUK-1050 — 历史迁移 apply 执行器的运行账本（grounding §15：分阶段离线可续跑
-- + locks/WAL/duration 观测）。
--
-- 这两张表是【工具运维账本】，不是 YUK-1044 的九张真相源表：它们记录 apply
-- 运行的进度/耗时/WAL 位移，供 crash 后续跑跳过已完成阶段、并对账输出观测。
-- 真相源表本身绝不 UPDATE（guarded 表由 0105/0106/0107 trigger 强制
-- append-only）；账本允许 UPDATE（阶段状态迁移），但不承载任何判分/作答事实。
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
	"rows_written" integer NOT NULL DEFAULT 0,
	"rows_already_present" integer NOT NULL DEFAULT 0,
	"error" text,
	CONSTRAINT "migration_apply_phase_status_ck" CHECK ("migration_apply_phase"."status" IN ('running','completed','failed','skipped')),
	CONSTRAINT "migration_apply_phase_name_ck" CHECK ("migration_apply_phase"."phase" IN ('preflight','plan','apply_mappings','apply_submissions','reconcile')),
	CONSTRAINT "migration_apply_phase_rows_ck" CHECK ("migration_apply_phase"."rows_written" >= 0 AND "migration_apply_phase"."rows_already_present" >= 0),
	CONSTRAINT "migration_apply_phase_run_fk" FOREIGN KEY ("run_id") REFERENCES "public"."migration_apply_run"("run_id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "migration_apply_phase_run_phase_uq" ON "migration_apply_phase" USING btree ("run_id","phase");
