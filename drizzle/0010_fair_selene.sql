ALTER TABLE "question" ADD COLUMN "figures" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "question" ADD COLUMN "image_refs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "question" ADD COLUMN "structured" jsonb;