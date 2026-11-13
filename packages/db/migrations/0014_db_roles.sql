-- Hand-written migration (T-P2-50): database roles and privileges of doc 10 §2.
-- The migrating role owns every QualityOS schema. Services log in as a role that is a member of
-- qos_app: DML on module tables, INSERT/SELECT only on the audit log, no DDL anywhere.
-- Group roles are NOLOGIN; login roles are provisioned by the migrate step from configuration.
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qos_app') THEN
		CREATE ROLE qos_app NOLOGIN;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qos_readonly') THEN
		CREATE ROLE qos_readonly NOLOGIN;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qos_retention') THEN
		CREATE ROLE qos_retention NOLOGIN;
	END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA platform, identity, projects, integrations, governance TO qos_app, qos_readonly, qos_retention;
--> statement-breakpoint
-- Services: read and write module data. No TRUNCATE, no REFERENCES/TRIGGER, no DDL.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA platform, identity, projects, integrations, governance TO qos_app;
--> statement-breakpoint
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA platform, identity, projects, integrations, governance TO qos_app;
--> statement-breakpoint
-- Tables created by later migrations (run by this same role) get the same grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA platform, identity, projects, integrations, governance
	GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO qos_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA platform, identity, projects, integrations, governance
	GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO qos_app;
--> statement-breakpoint
-- The audit log is append-only by privilege (M14-AC-01), on the parent and on every partition,
-- in addition to the trigger of migration 0001.
REVOKE UPDATE, DELETE, TRUNCATE ON governance.audit_events FROM qos_app;
--> statement-breakpoint
DO $$
DECLARE
	r record;
BEGIN
	FOR r IN
		SELECT c.oid::regclass AS part
		FROM pg_inherits i
		JOIN pg_class c ON c.oid = i.inhrelid
		WHERE i.inhparent = 'governance.audit_events'::regclass
	LOOP
		EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %s FROM qos_app', r.part);
		EXECUTE format('GRANT SELECT, INSERT ON %s TO qos_app', r.part);
	END LOOP;
END
$$;
--> statement-breakpoint
-- New monthly partitions are created by the owner (SECURITY DEFINER) with the same grants, so the
-- services can make sure a partition exists without holding any DDL privilege themselves.
CREATE OR REPLACE FUNCTION governance.ensure_audit_partition(month_start date) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, governance
AS $$
DECLARE
	from_ts date := date_trunc('month', month_start)::date;
	to_ts date := (date_trunc('month', month_start) + interval '1 month')::date;
	part_name text := 'audit_events_' || to_char(from_ts, 'YYYY_MM');
BEGIN
	IF to_regclass('governance.' || quote_ident(part_name)) IS NULL THEN
		EXECUTE format(
			'CREATE TABLE governance.%I PARTITION OF governance.audit_events FOR VALUES FROM (%L) TO (%L)',
			part_name, from_ts, to_ts
		);
		EXECUTE format('REVOKE ALL ON governance.%I FROM qos_app', part_name);
		EXECUTE format('GRANT SELECT, INSERT ON governance.%I TO qos_app', part_name);
		EXECUTE format('GRANT SELECT ON governance.%I TO qos_readonly, qos_retention', part_name);
	END IF;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION governance.ensure_audit_partition(date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION governance.ensure_audit_partition(date) TO qos_app;
--> statement-breakpoint
-- Read-only exports and support: everything except the secret store.
GRANT SELECT ON ALL TABLES IN SCHEMA platform, identity, projects, integrations, governance TO qos_readonly;
--> statement-breakpoint
REVOKE SELECT ON governance.secrets FROM qos_readonly;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA platform, identity, projects, integrations, governance
	GRANT SELECT ON TABLES TO qos_readonly;
--> statement-breakpoint
-- Retention purge job (P11): reads everything it decides on; its DELETE grants are added per
-- table together with each purge rule. Expired audit partitions are detached by the owner.
GRANT SELECT ON ALL TABLES IN SCHEMA platform, identity, projects, integrations, governance TO qos_retention;
--> statement-breakpoint
REVOKE SELECT ON governance.secrets FROM qos_retention;
