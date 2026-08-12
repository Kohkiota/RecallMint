ALTER TABLE "upload_operations" DROP CONSTRAINT "upload_operations_source_document_id_source_documents_id_fk";
--> statement-breakpoint
DROP INDEX "cards_answered_idx";--> statement-breakpoint
DROP INDEX "entity_mutations_entity_idx";--> statement-breakpoint
DROP INDEX "source_docs_user_exam_idx";--> statement-breakpoint
ALTER TABLE "upload_operations" ALTER COLUMN "source_document_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "upload_operations" ADD CONSTRAINT "upload_operations_source_document_id_source_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" DROP COLUMN "reference_count";--> statement-breakpoint
ALTER TABLE "exams" DROP COLUMN "question_no_format";--> statement-breakpoint
ALTER TABLE "exams" DROP COLUMN "archived_at";--> statement-breakpoint
ALTER TABLE "exams" DROP COLUMN "card_count";--> statement-breakpoint
ALTER TABLE "integration_failures" DROP COLUMN "retry_count";--> statement-breakpoint
ALTER TABLE "integration_failures" DROP COLUMN "next_retry_at";--> statement-breakpoint
ALTER TABLE "integration_failures" DROP COLUMN "resolved_at";--> statement-breakpoint
ALTER TABLE "integration_failures" DROP COLUMN "resolution_note";--> statement-breakpoint
ALTER TABLE "source_documents" DROP COLUMN "mode";--> statement-breakpoint
ALTER TABLE "source_documents" DROP COLUMN "ocr_cost_yen";--> statement-breakpoint
ALTER TABLE "upload_records" DROP COLUMN "filename";--> statement-breakpoint
ALTER TABLE "upload_records" DROP COLUMN "file_size_bytes";--> statement-breakpoint
ALTER TABLE "upload_records" DROP COLUMN "ocr_cost_yen";--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_count_nonneg" CHECK ("ai_usage"."count" >= 0);--> statement-breakpoint
ALTER TABLE "ai_usage_users" ADD CONSTRAINT "ai_usage_users_count_nonneg" CHECK ("ai_usage_users"."count" >= 0);--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_status_enum" CHECK ("assets"."status" IN ('reserved', 'ready', 'deleting', 'deleted'));--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_byte_size_nonneg" CHECK ("assets"."byte_size" >= 0);--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_width_positive" CHECK ("assets"."width" > 0);--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_height_positive" CHECK ("assets"."height" > 0);--> statement-breakpoint
ALTER TABLE "contact_messages" ADD CONSTRAINT "contact_messages_status_enum" CHECK ("contact_messages"."status" IN ('open', 'in_progress', 'resolved'));--> statement-breakpoint
ALTER TABLE "entity_mutations" ADD CONSTRAINT "entity_mutations_entity_type_enum" CHECK ("entity_mutations"."entity_type" IN ('card', 'tag_category', 'tag_option'));--> statement-breakpoint
ALTER TABLE "entity_mutations" ADD CONSTRAINT "entity_mutations_op_enum" CHECK ("entity_mutations"."op" IN ('create', 'update_field', 'delete'));--> statement-breakpoint
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_file_type_enum" CHECK ("source_documents"."file_type" IN ('pdf', 'image', 'csv', 'markdown'));--> statement-breakpoint
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_status_enum" CHECK ("source_documents"."status" IN ('processing', 'completed', 'failed'));--> statement-breakpoint
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_file_size_bytes_nonneg" CHECK ("source_documents"."file_size_bytes" >= 0);--> statement-breakpoint
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_pages_processed_nonneg" CHECK ("source_documents"."pages_processed" >= 0);--> statement-breakpoint
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_pages_total_nonneg" CHECK ("source_documents"."pages_total" IS NULL OR "source_documents"."pages_total" >= 0);--> statement-breakpoint
ALTER TABLE "study_days" ADD CONSTRAINT "study_days_review_count_nonneg" CHECK ("study_days"."review_count" >= 0);--> statement-breakpoint
ALTER TABLE "study_days" ADD CONSTRAINT "study_days_correct_count_nonneg" CHECK ("study_days"."correct_count" >= 0);--> statement-breakpoint
ALTER TABLE "study_days" ADD CONSTRAINT "study_days_distinct_card_count_nonneg" CHECK ("study_days"."distinct_card_count" >= 0);--> statement-breakpoint
ALTER TABLE "tag_categories" ADD CONSTRAINT "tag_categories_select_type_enum" CHECK ("tag_categories"."select_type" IN ('single', 'multi'));--> statement-breakpoint
ALTER TABLE "tombstones" ADD CONSTRAINT "tombstones_entity_type_enum" CHECK ("tombstones"."entity_type" IN ('exam', 'card', 'tag_category', 'tag_option'));--> statement-breakpoint
ALTER TABLE "upload_operations" ADD CONSTRAINT "upload_operations_status_enum" CHECK ("upload_operations"."status" IN ('prepared', 'processing', 'completed', 'terminal_failed'));--> statement-breakpoint
ALTER TABLE "upload_operations" ADD CONSTRAINT "upload_operations_attempt_count_nonneg" CHECK ("upload_operations"."attempt_count" >= 0);--> statement-breakpoint
ALTER TABLE "upload_operations" ADD CONSTRAINT "upload_operations_expected_source_count_nonneg" CHECK ("upload_operations"."expected_source_count" >= 0);--> statement-breakpoint
ALTER TABLE "upload_records" ADD CONSTRAINT "upload_records_status_enum" CHECK ("upload_records"."status" IN ('completed', 'failed'));--> statement-breakpoint
ALTER TABLE "upload_records" ADD CONSTRAINT "upload_records_pages_processed_nonneg" CHECK ("upload_records"."pages_processed" >= 0);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_plan_enum" CHECK ("users"."plan" IN ('free', 'standard', 'pro'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_subscription_status_enum" CHECK ("users"."subscription_status" IS NULL OR "users"."subscription_status" IN ('active', 'past_due', 'canceled'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_billing_interval_enum" CHECK ("users"."billing_interval" IS NULL OR "users"."billing_interval" IN ('month', 'year'));