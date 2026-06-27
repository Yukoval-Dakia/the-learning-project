CREATE TABLE "learner_axis_state" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_kind" text DEFAULT 'knowledge' NOT NULL,
	"subject_id" text NOT NULL,
	"drift_v" double precision,
	"boundary_a" double precision,
	"ter" double precision,
	"n_obs" integer DEFAULT 0 NOT NULL,
	"provenance" text DEFAULT 'adaptive' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "learner_axis_state_unique" ON "learner_axis_state" USING btree ("subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "learner_axis_state_subject_idx" ON "learner_axis_state" USING btree ("subject_id");