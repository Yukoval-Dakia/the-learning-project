CREATE TABLE "model_admission_slice" (
	"slice_id" text PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"response_class" text NOT NULL,
	"task_kind" text NOT NULL,
	"model" text NOT NULL,
	"model_version" text NOT NULL,
	"holdout_evidence_ref" text NOT NULL,
	"admitted_by" text NOT NULL,
	"admitted_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	CONSTRAINT "model_admission_slice_response_class_ck" CHECK ("model_admission_slice"."response_class" IN ('blank','free')),
	CONSTRAINT "model_admission_slice_status_ck" CHECK ("model_admission_slice"."status" IN ('active','retired'))
);
--> statement-breakpoint
CREATE INDEX "model_admission_slice_lookup_idx" ON "model_admission_slice" USING btree ("subject","response_class","task_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "model_admission_slice_natural_key" ON "model_admission_slice" USING btree ("subject","response_class","task_kind","model","model_version");--> statement-breakpoint
-- YUK-1496: model_admission_slice is serving-gate configuration (which model
-- slices may grade), not learner state. Least-privilege tool roles legitimately
-- read it on every serving decision via resolveModelAdmissionContext; SELECT is
-- the only privilege they need. PUBLIC covers ephemeral least-privilege roles.
GRANT SELECT ON "model_admission_slice" TO PUBLIC;
