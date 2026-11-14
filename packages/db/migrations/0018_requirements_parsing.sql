CREATE TABLE "requirements"."parsed_documents" (
	"snapshot_id" uuid PRIMARY KEY NOT NULL,
	"parser_version" text NOT NULL,
	"stored_object_key" text NOT NULL,
	"page_count" integer,
	"languages" text[] NOT NULL,
	"ocr_pages" integer DEFAULT 0 NOT NULL,
	"block_count" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "requirements"."extracted_items" ADD COLUMN "parent_item_id" uuid;--> statement-breakpoint
ALTER TABLE "requirements"."extracted_items" ADD COLUMN "external_key" text;--> statement-breakpoint
ALTER TABLE "requirements"."extracted_items" ADD COLUMN "rule" text;--> statement-breakpoint
ALTER TABLE "requirements"."source_snapshots" ADD COLUMN "file_name" text;--> statement-breakpoint
ALTER TABLE "requirements"."source_snapshots" ADD COLUMN "file_kind" text;--> statement-breakpoint
ALTER TABLE "requirements"."source_snapshots" ADD COLUMN "content_type" text;--> statement-breakpoint
ALTER TABLE "requirements"."source_snapshots" ADD COLUMN "size_bytes" integer;--> statement-breakpoint
ALTER TABLE "requirements"."parsed_documents" ADD CONSTRAINT "parsed_documents_snapshot_id_source_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "requirements"."source_snapshots"("id") ON DELETE no action ON UPDATE no action;