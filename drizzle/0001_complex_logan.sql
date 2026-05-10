ALTER TABLE "judgment" ADD CONSTRAINT "judgment_score_range" CHECK ("judgment"."score" BETWEEN 0 AND 1);--> statement-breakpoint
ALTER TABLE "knowledge" ADD CONSTRAINT "knowledge_base_mastery_range" CHECK ("knowledge"."base_mastery" BETWEEN 0 AND 1);--> statement-breakpoint
ALTER TABLE "knowledge" ADD CONSTRAINT "knowledge_ai_delta_mastery_range" CHECK ("knowledge"."ai_delta_mastery" BETWEEN -0.2 AND 0.2);--> statement-breakpoint
ALTER TABLE "learning_item" ADD CONSTRAINT "learning_item_ai_score_range" CHECK ("learning_item"."ai_score" BETWEEN 0 AND 1);--> statement-breakpoint
ALTER TABLE "question" ADD CONSTRAINT "question_difficulty_range" CHECK ("question"."difficulty" BETWEEN 1 AND 5);--> statement-breakpoint
ALTER TABLE "question_block" ADD CONSTRAINT "question_block_extraction_confidence_range" CHECK ("question_block"."extraction_confidence" BETWEEN 0 AND 1);