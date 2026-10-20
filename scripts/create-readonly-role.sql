-- Creates a SELECT-only role for nutboard on a Nutshell mint database.
--
-- Run it as the PostgreSQL superuser, connected to the MINT database. On the database host the
-- postgres OS user needs no password (peer authentication over the Unix socket):
--
--   su - postgres -c "psql -d mint -f /opt/nutboard/scripts/create-readonly-role.sql"
--
-- (replace "mint" with the mint database's name; `su - postgres -c "psql -l"` lists them).
-- From elsewhere, with a password-authenticated superuser:
--
--   psql "postgres://postgres:secret@db-host:5432/mint" -f scripts/create-readonly-role.sql
--
-- The first run creates the role with a random password and prints a ready-made DATABASE_URL.
-- Later runs keep the role and its password and only refresh the grants: re-run the script after
-- upgrading Nutshell so that tables added by new migrations are covered too. Needs PostgreSQL 13+.

\set ON_ERROR_STOP on

-- Refuse to run anywhere but the mint database (the role would otherwise be granted the wrong tables).
DO $$
BEGIN
  IF to_regclass('public.keysets') IS NULL THEN
    RAISE EXCEPTION 'database "%" has no keysets table. Connect to the mint database instead: psql -d <mint-db> -f create-readonly-role.sql',
      current_database();
  END IF;
END $$;

SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nutboard_ro') AS have_role \gset
\if :have_role
\echo Role nutboard_ro already exists: keeping its password, refreshing the grants.
\else
SELECT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') AS newpw \gset
CREATE ROLE nutboard_ro LOGIN PASSWORD :'newpw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
SELECT format('postgres://nutboard_ro:%s@localhost:5432/%s', :'newpw', current_database()) AS url \gset
\echo
\echo Created role nutboard_ro. Its password is shown only now; put this line in /etc/nutboard.env (or .env):
\echo DATABASE_URL=:url
\echo
\endif

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO nutboard_ro', current_database());
END $$;
GRANT USAGE ON SCHEMA public TO nutboard_ro;

-- Read access to every mint table and view ...
GRANT SELECT ON ALL TABLES IN SCHEMA public TO nutboard_ro;

-- ... except the keyset secrets: revoke the table-level grant on keysets and re-grant
-- only the non-secret columns (whatever exists on this Nutshell version).
REVOKE ALL ON public.keysets FROM nutboard_ro;
DO $$
DECLARE cols text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'keysets'
     AND column_name NOT IN ('seed', 'encrypted_seed', 'seed_encryption_method');
  EXECUTE format('GRANT SELECT (%s) ON public.keysets TO nutboard_ro', cols);
END $$;

-- Belt and braces: even if someone later grants more, sessions of this role start read-only.
ALTER ROLE nutboard_ro SET default_transaction_read_only = on;

\echo Grants refreshed for nutboard_ro on database :DBNAME (SELECT only, no keyset secrets).
