CREATE TABLE "difficulty_calibration_label" (
	"id" text PRIMARY KEY NOT NULL,
	"question_id" text NOT NULL,
	"attempt_event_id" text NOT NULL,
	"theta_snapshot" real NOT NULL,
	"outcome" integer NOT NULL,
	"b_label" real NOT NULL,
	"inclusion_probability" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "item_calibration" ADD COLUMN "b_anchor" real;--> statement-breakpoint
ALTER TABLE "item_calibration" ADD COLUMN "b_calib" real;--> statement-breakpoint
ALTER TABLE "item_calibration" ADD COLUMN "calibration_n" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "item_calibration" ADD COLUMN "calibration_weight" real;--> statement-breakpoint
ALTER TABLE "item_calibration" ADD COLUMN "last_calibrated_at" timestamp with time zone;--> statement-breakpoint
-- YUK-361 Phase 6 backfill: 既有行的现存 b 列就是冷启锚 → 回填到 b_anchor。
-- b_calib 保持 NULL（重标定攒够标签前不去偏）；effectiveB(row)=b_calib ?? b_anchor ?? b
-- 故回填后既有行的 effectiveB 仍等于原 b（read-compat NO-OP，零行为变更）。
UPDATE "item_calibration" SET "b_anchor" = "b" WHERE "b" IS NOT NULL AND "b_anchor" IS NULL;--> statement-breakpoint
CREATE INDEX "difficulty_calibration_label_question_idx" ON "difficulty_calibration_label" USING btree ("question_id");--> statement-breakpoint
CREATE UNIQUE INDEX "difficulty_calibration_label_attempt_unique" ON "difficulty_calibration_label" USING btree ("attempt_event_id");