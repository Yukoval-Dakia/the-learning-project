ALTER TABLE "intervention" ADD COLUMN "preparation_waits" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "intervention" ADD COLUMN "preparation_wait_until" timestamp with time zone;