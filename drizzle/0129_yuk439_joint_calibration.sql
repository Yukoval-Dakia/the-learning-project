CREATE TABLE "difficulty_calibration_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"question_id" text NOT NULL,
	"attempt_event_id" text NOT NULL,
	"theta_snapshot" real NOT NULL,
	"score" real NOT NULL,
	"evidence_source" text NOT NULL,
	"judge_route" text,
	"judge_confidence" real,
	"inclusion_probability" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "item_calibration" ADD COLUMN "b_post" real;--> statement-breakpoint
ALTER TABLE "item_calibration" ADD COLUMN "posterior_variance" real;--> statement-breakpoint
ALTER TABLE "item_calibration" ADD COLUMN "calibration_source" text;--> statement-breakpoint
CREATE INDEX "difficulty_calibration_evidence_question_idx" ON "difficulty_calibration_evidence" USING btree ("question_id");--> statement-breakpoint
CREATE UNIQUE INDEX "difficulty_calibration_evidence_attempt_unique" ON "difficulty_calibration_evidence" USING btree ("attempt_event_id");--> statement-breakpoint
CREATE INDEX "difficulty_calibration_evidence_source_idx" ON "difficulty_calibration_evidence" USING btree ("evidence_source");--> statement-breakpoint
-- YUK-439 backfill ①：既有 difficulty_calibration_label（active-PPI 慢热资产）一次性
-- 回填进证据账本。旧 hook 的两道门控（isObjectiveJudgeRoute 仅 exact/keyword +
-- softmax_mfi 真 π_i）保证了回填行的忠实值：evidence_source='stream_softmax'、
-- judge_route='exact'（deterministic ⇒ 可靠度 1）、score=outcome（0/1 特例）、π 原样。
-- id 复用 label.id（跨表无冲突，provenance 可追）。
INSERT INTO "difficulty_calibration_evidence" (
  "id", "question_id", "attempt_event_id", "theta_snapshot", "score",
  "evidence_source", "judge_route", "judge_confidence", "inclusion_probability", "created_at"
)
SELECT
  l."id", l."question_id", l."attempt_event_id", l."theta_snapshot", l."outcome"::real,
  'stream_softmax', 'exact', NULL, l."inclusion_probability", l."created_at"
FROM "difficulty_calibration_label" l
ON CONFLICT ("attempt_event_id") DO NOTHING;
--> statement-breakpoint
-- YUK-439 backfill ②：item_calibration 后验列初始化。
--   b_post = COALESCE(b_calib, b_anchor)——既有 AIPW 校准值一次性承接（部署时刻读数
--     连续，无回退闪变；首批标定会以先验+证据全量重算取代它）；
--   posterior_variance = τ_j²（source 经登记映射；confusion 见 core/difficulty-posterior.ts
--     priorTau——不用 confidence 折算，ADR-0035 2026-06-20 增补）；
--   calibration_source = b_calib 非 NULL ? 'legacy_calib' : 'prior'。
UPDATE "item_calibration"
SET
  "b_post" = COALESCE("b_calib", "b_anchor"),
  "posterior_variance" = POWER(CASE "source"
    WHEN 'fixed_anchor' THEN 0.5
    WHEN 'llm_prior_llasa' THEN 1.5
    WHEN 'llm_prior' THEN 2.0
    ELSE 2.5 END, 2),
  "calibration_source" = CASE WHEN "b_calib" IS NOT NULL THEN 'legacy_calib' ELSE 'prior' END
WHERE "b_anchor" IS NOT NULL AND "b_post" IS NULL;
