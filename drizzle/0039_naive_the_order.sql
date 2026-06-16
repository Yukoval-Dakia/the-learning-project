ALTER TABLE "knowledge" ADD COLUMN "embedding" vector(1024);--> statement-breakpoint
ALTER TABLE "knowledge" ADD COLUMN "embed_model" text;--> statement-breakpoint
ALTER TABLE "knowledge" ADD COLUMN "embed_version" integer;--> statement-breakpoint
ALTER TABLE "question" ADD COLUMN "embedding" vector(1024);--> statement-breakpoint
ALTER TABLE "question" ADD COLUMN "embed_model" text;--> statement-breakpoint
ALTER TABLE "question" ADD COLUMN "embed_version" integer;