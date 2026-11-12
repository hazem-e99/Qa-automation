CREATE TABLE "governance"."approval_decisions" (
	"request_id" uuid NOT NULL,
	"approver_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"comment" text,
	"self_approval" boolean DEFAULT false NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "approval_decisions_request_id_approver_id_pk" PRIMARY KEY("request_id","approver_id")
);
--> statement-breakpoint
CREATE TABLE "governance"."approval_policies" (
	"project_id" uuid NOT NULL,
	"action" text NOT NULL,
	"rules" jsonb NOT NULL,
	"version" integer NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "approval_policies_project_id_action_pk" PRIMARY KEY("project_id","action")
);
--> statement-breakpoint
CREATE TABLE "governance"."approval_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"policy_version" integer NOT NULL,
	"rules" jsonb NOT NULL,
	"requested_by" uuid NOT NULL,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "governance"."notification_preferences" (
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"in_app" boolean NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "notification_preferences_user_id_type_pk" PRIMARY KEY("user_id","type")
);
--> statement-breakpoint
CREATE TABLE "governance"."notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "governance"."approval_decisions" ADD CONSTRAINT "approval_decisions_request_id_approval_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "governance"."approval_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_requests_project_ix" ON "governance"."approval_requests" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_requests_one_pending_ux" ON "governance"."approval_requests" USING btree ("project_id","action","target_type","target_id") WHERE "governance"."approval_requests"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_user_dedupe_ux" ON "governance"."notifications" USING btree ("user_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "notifications_user_ix" ON "governance"."notifications" USING btree ("user_id","created_at");