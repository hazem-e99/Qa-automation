-- Hand-written migration: envelope-encrypted secrets (the governance schema is outside drizzle-kit).
CREATE TABLE "governance"."secrets" (
	"ref" uuid PRIMARY KEY NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"purpose" text NOT NULL,
	"ciphertext" text NOT NULL,
	"wrapped_dek" text NOT NULL,
	"key_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"rotated_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "secrets_owner_ix" ON "governance"."secrets" ("owner_type", "owner_id");
--> statement-breakpoint
CREATE INDEX "secrets_expires_ix" ON "governance"."secrets" ("expires_at") WHERE "expires_at" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "identity"."project_memberships"
	ADD CONSTRAINT "project_memberships_project_fk"
	FOREIGN KEY ("project_id") REFERENCES "projects"."projects"("id") ON DELETE CASCADE;
