ALTER TABLE "goal" ADD COLUMN "effective_from" date;--> statement-breakpoint
ALTER TABLE "goal" ADD COLUMN "effective_until" date;--> statement-breakpoint
ALTER TABLE "goal" ADD COLUMN "steering" jsonb;