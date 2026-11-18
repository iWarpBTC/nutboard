-- Creates a SELECT-only role for nutboard on a mint database (Nutshell or CDK) or an LNbits database.
--
-- Run it as the PostgreSQL superuser, connected to the database nutboard should read (not to "postgres"). On the database host the
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
-- upgrading the mint so that tables added by new migrations are covered too. The role is shared by
-- the whole PostgreSQL cluster, so one role can read several mint databases: run the script once in
-- each of them. Needs PostgreSQL 13+.

\set ON_ERROR_STOP on

-- What is this database? Refuse to run anywhere else (the role would be granted the wrong tables).
SELECT to_regclass('public.keysets') IS NOT NULL AND to_regclass('public.promises') IS NOT NULL AS is_nutshell,
       to_regclass('public.keyset') IS NOT NULL AND to_regclass('public.blind_signature') IS NOT NULL AS is_cdk,
       to_regclass('public.apipayments') IS NOT NULL AND to_regclass('public.wallets') IS NOT NULL AS is_lnbits \gset
\set envvar DATABASE_URL
\if :is_nutshell
\echo Nutshell mint database detected.
\elif :is_cdk
\echo CDK mint database detected.
\elif :is_lnbits
\echo LNbits database detected.
\set envvar LNBITS_DATABASE_URL
\else
DO $$
BEGIN
  RAISE EXCEPTION 'database "%" holds neither Nutshell (keysets, promises) nor CDK (keyset, blind_signature) mint tables nor LNbits (wallets, apipayments). Connect to the right database: psql -d <database> -f create-readonly-role.sql',
    current_database();
END $$;
\endif

SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nutboard_ro') AS have_role \gset
\if :have_role
\echo Role nutboard_ro already exists: keeping its password, refreshing the grants.
\else
SELECT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') AS newpw \gset
CREATE ROLE nutboard_ro LOGIN PASSWORD :'newpw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
SELECT format('postgres://nutboard_ro:%s@localhost:5432/%s', :'newpw', current_database()) AS url \gset
\echo
\echo Created role nutboard_ro. Its password is shown only now; put this line in /etc/nutboard.env (or .env):
\echo :envvar=:url
\echo
\endif

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO nutboard_ro', current_database());
END $$;
GRANT USAGE ON SCHEMA public TO nutboard_ro;

\if :is_nutshell

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

\elif :is_cdk

-- CDK: grant exactly what nutboard reads and nothing else. Start from a clean slate so that a
-- re-run also takes away anything granted more broadly before.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM nutboard_ro;

-- Whole tables without secrets (only those that exist on this CDK version). kv_store is left out
-- on purpose: the mint keeps its configuration there.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['keyset', 'keyset_amounts', 'mint_quote', 'mint_quote_payments', 'mint_quote_issued',
                           'melt_quote', 'melt_request', 'completed_operations', 'saga_state', 'migrations']
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON public.%I TO nutboard_ro', t);
    END IF;
  END LOOP;
END $$;

-- Inputs and outputs: amounts, state and bookkeeping columns only. The spent secrets, witnesses
-- and DLEQ proofs stay out of reach.
DO $$
DECLARE cols text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'proof'
     AND column_name IN ('amount', 'keyset_id', 'state', 'quote_id', 'created_time', 'operation_kind', 'operation_id');
  EXECUTE format('GRANT SELECT (%s) ON public.proof TO nutboard_ro', cols);

  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'blind_signature'
     AND column_name IN ('amount', 'keyset_id', 'c', 'quote_id', 'created_time', 'signed_time', 'operation_kind', 'operation_id');
  EXECUTE format('GRANT SELECT (%s) ON public.blind_signature TO nutboard_ro', cols);
END $$;

\else

-- LNbits: column by column. Start from a clean slate so that a re-run also takes away anything
-- granted more broadly before.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM nutboard_ro;

-- LNbits' own view of what each wallet holds, and its migration level.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['balances', 'dbversions']
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON public.%I TO nutboard_ro', t);
    END IF;
  END LOOP;
END $$;

-- Who owns which wallet and what moved when. Out of reach stay the API keys (adminkey, inkey), password
-- hashes and e-mail addresses, invoices, preimages, memos and everything extensions keep in their own schemas.
DO $$
DECLARE
  wanted CONSTANT jsonb := '{
    "accounts":    ["id", "username", "created_at", "updated_at"],
    "wallets":     ["id", "name", "user", "currency", "deleted", "created_at", "updated_at", "wallet_type", "shared_wallet_id"],
    "apipayments": ["checking_id", "amount", "fee", "wallet_id", "time", "status", "tag", "extension", "created_at", "updated_at"]
  }';
  t text;
  cols text;
BEGIN
  FOR t IN SELECT jsonb_object_keys(wanted)
  LOOP
    SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO cols
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = t
       AND column_name IN (SELECT jsonb_array_elements_text(wanted -> t));
    IF cols IS NOT NULL THEN
      EXECUTE format('GRANT SELECT (%s) ON public.%I TO nutboard_ro', cols, t);
    END IF;
  END LOOP;
END $$;

\endif

-- Belt and braces: even if someone later grants more, sessions of this role start read-only.
ALTER ROLE nutboard_ro SET default_transaction_read_only = on;

\echo Grants refreshed for nutboard_ro on database :DBNAME (SELECT only, no secrets).
