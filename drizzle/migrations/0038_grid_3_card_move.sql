ALTER TABLE "entity_mutations" DROP CONSTRAINT "entity_mutations_entity_type_enum";--> statement-breakpoint
ALTER TABLE "entity_mutations" DROP CONSTRAINT "entity_mutations_op_enum";--> statement-breakpoint
ALTER TABLE "entity_mutations" ADD CONSTRAINT "entity_mutations_entity_type_enum" CHECK ("entity_mutations"."entity_type" IN ('card', 'tag_category', 'tag_option', 'card_move'));--> statement-breakpoint
ALTER TABLE "entity_mutations" ADD CONSTRAINT "entity_mutations_op_enum" CHECK ("entity_mutations"."op" IN ('create', 'update_field', 'delete', 'move'));