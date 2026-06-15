ALTER TABLE "mastery_state" ADD COLUMN "theta_precision" real DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "mastery_state" ADD COLUMN "last_theta_delta" real;