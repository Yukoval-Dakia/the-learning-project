CREATE TABLE "item_calibration" (
	"id" text PRIMARY KEY NOT NULL,
	"question_id" text NOT NULL,
	"b" real,
	"confidence" real,
	"track" text DEFAULT 'hard' NOT NULL,
	"source" text NOT NULL,
	"irt_a" real,
	"irt_c" real,
	"cdm_json" jsonb,
	"kt_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mastery_state" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_kind" text DEFAULT 'knowledge' NOT NULL,
	"subject_id" text NOT NULL,
	"theta_hat" real DEFAULT 0 NOT NULL,
	"evidence_count" integer DEFAULT 0 NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"fail_count" integer DEFAULT 0 NOT NULL,
	"last_outcome_at" timestamp with time zone,
	"calibration_residual" real,
	"fluency_illusion_flag" boolean,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "item_calibration_question_unique" ON "item_calibration" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "item_calibration_track_idx" ON "item_calibration" USING btree ("track");--> statement-breakpoint
CREATE UNIQUE INDEX "mastery_state_unique" ON "mastery_state" USING btree ("subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "mastery_state_subject_idx" ON "mastery_state" USING btree ("subject_id");