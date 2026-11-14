CREATE SCHEMA "requirements";
--> statement-breakpoint
CREATE TABLE "requirements"."acceptance_criteria" (
	"id" uuid PRIMARY KEY NOT NULL,
	"requirement_version_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"text" text NOT NULL,
	"origin" text NOT NULL,
	"extracted_item_id" uuid
);
--> statement-breakpoint
CREATE TABLE "requirements"."extracted_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"locator" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"language" text,
	"confidence" numeric(4, 3) NOT NULL,
	"method" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requirements"."requirement_findings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"subject_ids" uuid[] NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolution" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "requirements"."requirement_provenance" (
	"requirement_version_id" uuid NOT NULL,
	"extracted_item_id" uuid NOT NULL,
	CONSTRAINT "requirement_provenance_requirement_version_id_extracted_item_id_pk" PRIMARY KEY("requirement_version_id","extracted_item_id")
);
--> statement-breakpoint
CREATE TABLE "requirements"."requirement_sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"binding_id" uuid,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "requirement_sources_kind_ck" CHECK ("requirements"."requirement_sources"."kind" in ('external', 'document_set', 'spreadsheet', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "requirements"."requirement_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"requirement_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"body_md" text NOT NULL,
	"priority" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"origin" text NOT NULL,
	"state" text NOT NULL,
	"content_hash" text NOT NULL,
	"search_text" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"approval_request_id" uuid
);
--> statement-breakpoint
CREATE TABLE "requirements"."requirements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"key" text NOT NULL,
	"effective_version_id" uuid,
	"latest_version_id" uuid,
	"source_removed" boolean DEFAULT false NOT NULL,
	"diverged_from_source" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requirements"."source_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"title" text NOT NULL,
	"language_hint" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requirements"."source_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"document_id" uuid,
	"external_ref_id" uuid,
	"external_version" text,
	"checksum" text NOT NULL,
	"stored_object_key" text,
	"captured_by" uuid,
	"captured_at" timestamp with time zone NOT NULL,
	"parse_status" text NOT NULL,
	"extraction_quality" jsonb
);
--> statement-breakpoint
ALTER TABLE "requirements"."acceptance_criteria" ADD CONSTRAINT "acceptance_criteria_requirement_version_id_requirement_versions_id_fk" FOREIGN KEY ("requirement_version_id") REFERENCES "requirements"."requirement_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirements"."extracted_items" ADD CONSTRAINT "extracted_items_snapshot_id_source_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "requirements"."source_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirements"."requirement_provenance" ADD CONSTRAINT "requirement_provenance_requirement_version_id_requirement_versions_id_fk" FOREIGN KEY ("requirement_version_id") REFERENCES "requirements"."requirement_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirements"."requirement_provenance" ADD CONSTRAINT "requirement_provenance_extracted_item_id_extracted_items_id_fk" FOREIGN KEY ("extracted_item_id") REFERENCES "requirements"."extracted_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirements"."requirement_versions" ADD CONSTRAINT "requirement_versions_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "requirements"."requirements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirements"."source_documents" ADD CONSTRAINT "source_documents_source_id_requirement_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "requirements"."requirement_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirements"."source_snapshots" ADD CONSTRAINT "source_snapshots_source_id_requirement_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "requirements"."requirement_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirements"."source_snapshots" ADD CONSTRAINT "source_snapshots_document_id_source_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "requirements"."source_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "acceptance_criteria_version_ordinal_ux" ON "requirements"."acceptance_criteria" USING btree ("requirement_version_id","ordinal");--> statement-breakpoint
CREATE INDEX "extracted_items_snapshot_ix" ON "requirements"."extracted_items" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "extracted_items_project_status_ix" ON "requirements"."extracted_items" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "requirement_findings_project_ix" ON "requirements"."requirement_findings" USING btree ("project_id","type","status");--> statement-breakpoint
CREATE UNIQUE INDEX "requirement_sources_project_name_ux" ON "requirements"."requirement_sources" USING btree ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "requirement_versions_number_ux" ON "requirements"."requirement_versions" USING btree ("requirement_id","number");--> statement-breakpoint
CREATE INDEX "requirement_versions_project_state_ix" ON "requirements"."requirement_versions" USING btree ("project_id","state");--> statement-breakpoint
CREATE INDEX "requirement_versions_search_trgm_ix" ON "requirements"."requirement_versions" USING gin ("search_text" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "requirements_project_key_ux" ON "requirements"."requirements" USING btree ("project_id","key");--> statement-breakpoint
CREATE INDEX "source_documents_source_ix" ON "requirements"."source_documents" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_snapshots_source_checksum_ux" ON "requirements"."source_snapshots" USING btree ("source_id","checksum");--> statement-breakpoint
CREATE INDEX "source_snapshots_project_ix" ON "requirements"."source_snapshots" USING btree ("project_id","captured_at");