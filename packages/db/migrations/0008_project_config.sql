CREATE TABLE "projects"."project_bindings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"role" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"config" jsonb NOT NULL,
	"mode" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"started_by" uuid NOT NULL,
	"ended_by" uuid
);
--> statement-breakpoint
CREATE TABLE "projects"."project_environments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"base_urls" text[] NOT NULL,
	"allowed_hosts" text[] NOT NULL,
	"is_production" boolean DEFAULT false NOT NULL,
	"auth_secret_ref" text,
	"auth_secret_updated_at" timestamp with time zone,
	"reset_hook_url" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects"."project_settings" (
	"project_id" uuid NOT NULL,
	"section" text NOT NULL,
	"schema_version" integer NOT NULL,
	"data" jsonb NOT NULL,
	"version" integer NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "project_settings_project_id_section_pk" PRIMARY KEY("project_id","section")
);
--> statement-breakpoint
CREATE TABLE "projects"."project_settings_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"section" text NOT NULL,
	"version" integer NOT NULL,
	"data" jsonb NOT NULL,
	"changed_by" uuid NOT NULL,
	"changed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects"."projects" ADD COLUMN "is_demo" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects"."project_bindings" ADD CONSTRAINT "project_bindings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects"."project_environments" ADD CONSTRAINT "project_environments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects"."project_settings" ADD CONSTRAINT "project_settings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects"."project_settings_history" ADD CONSTRAINT "project_settings_history_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_bindings_one_active_ux" ON "projects"."project_bindings" USING btree ("project_id","role") WHERE "projects"."project_bindings"."ended_at" is null and "projects"."project_bindings"."role" not in ('requirements', 'notifications');--> statement-breakpoint
CREATE INDEX "project_bindings_connection_ix" ON "projects"."project_bindings" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "project_bindings_project_ix" ON "projects"."project_bindings" USING btree ("project_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "project_environments_name_ux" ON "projects"."project_environments" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "project_settings_history_ix" ON "projects"."project_settings_history" USING btree ("project_id","section","changed_at");--> statement-breakpoint
ALTER TABLE "projects"."project_bindings" ADD CONSTRAINT "project_bindings_connection_fk" FOREIGN KEY ("connection_id") REFERENCES "integrations"."connections"("id");
