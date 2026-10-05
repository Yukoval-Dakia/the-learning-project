CREATE TABLE "assessment_response_draft" (
	"issuance_id" text PRIMARY KEY NOT NULL,
	"evaluation_group_ref" text,
	"response_set" jsonb NOT NULL,
	"group_evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"save_epoch" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "assessment_response_draft_save_epoch_ck" CHECK ("assessment_response_draft"."save_epoch" >= 0)
);
--> statement-breakpoint
ALTER TABLE "assessment_response_draft" ADD CONSTRAINT "assessment_response_draft_issuance_fk" FOREIGN KEY ("issuance_id") REFERENCES "public"."assessment_issuance"("issuance_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assessment_response_draft_group_ref_idx" ON "assessment_response_draft" USING btree ("evaluation_group_ref");