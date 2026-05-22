CREATE INDEX "cards_source_document_idx" ON "cards" USING btree ("source_document_id");--> statement-breakpoint
CREATE INDEX "contact_messages_user_idx" ON "contact_messages" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "source_docs_exam_idx" ON "source_documents" USING btree ("exam_id");