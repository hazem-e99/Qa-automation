-- Hand-written migration: privileges for the new `requirements` schema (same rules as migration
-- 0014) and immutability of requirement versions and their acceptance criteria (BR-M04-2).
GRANT USAGE ON SCHEMA requirements TO qos_app, qos_readonly, qos_retention;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA requirements TO qos_app;
--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA requirements TO qos_readonly, qos_retention;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA requirements GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO qos_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA requirements GRANT SELECT ON TABLES TO qos_readonly, qos_retention;
--> statement-breakpoint
-- Content of a version never changes; only its workflow columns do.
CREATE FUNCTION requirements.requirement_versions_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'requirement versions cannot be deleted' USING ERRCODE = 'insufficient_privilege';
	END IF;
	IF NEW.requirement_id IS DISTINCT FROM OLD.requirement_id
		OR NEW.project_id IS DISTINCT FROM OLD.project_id
		OR NEW.number IS DISTINCT FROM OLD.number
		OR NEW.title IS DISTINCT FROM OLD.title
		OR NEW.body_md IS DISTINCT FROM OLD.body_md
		OR NEW.priority IS DISTINCT FROM OLD.priority
		OR NEW.tags IS DISTINCT FROM OLD.tags
		OR NEW.origin IS DISTINCT FROM OLD.origin
		OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
		OR NEW.search_text IS DISTINCT FROM OLD.search_text
		OR NEW.created_by IS DISTINCT FROM OLD.created_by
		OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION 'requirement version content is immutable; create a new version'
			USING ERRCODE = 'insufficient_privilege';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER requirement_versions_immutable
	BEFORE UPDATE OR DELETE ON requirements.requirement_versions
	FOR EACH ROW EXECUTE FUNCTION requirements.requirement_versions_immutable();
--> statement-breakpoint
CREATE FUNCTION requirements.acceptance_criteria_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'acceptance criteria belong to an immutable version (% refused)', TG_OP
		USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER acceptance_criteria_immutable
	BEFORE UPDATE OR DELETE ON requirements.acceptance_criteria
	FOR EACH ROW EXECUTE FUNCTION requirements.acceptance_criteria_immutable();
