-- CDK mint schema as produced by cdk-sql-common's PostgreSQL migrations at CDK v0.18.3 (all 28 applied
-- to an empty database, then dumped with pg_dump --schema-only), plus the migrations bookkeeping table
-- that cdk creates at run time.
-- FOR LOCAL DEVELOPMENT ONLY: this file is used by scripts/seed-dev-cdk.ts to build a fixture
-- database. Never run it against a real mint.

DROP TABLE IF EXISTS mint_quote_payments CASCADE;
DROP TABLE IF EXISTS mint_quote_issued CASCADE;
DROP TABLE IF EXISTS melt_request CASCADE;
DROP TABLE IF EXISTS saga_state CASCADE;
DROP TABLE IF EXISTS completed_operations CASCADE;
DROP TABLE IF EXISTS keyset_amounts CASCADE;
DROP TABLE IF EXISTS keyset_epoch CASCADE;
DROP TABLE IF EXISTS kv_store CASCADE;
DROP TABLE IF EXISTS blind_signature CASCADE;
DROP TABLE IF EXISTS proof CASCADE;
DROP TABLE IF EXISTS melt_quote CASCADE;
DROP TABLE IF EXISTS mint_quote CASCADE;
DROP TABLE IF EXISTS keyset CASCADE;
DROP TABLE IF EXISTS migrations CASCADE;

CREATE TABLE blind_signature (
    blinded_message bytea NOT NULL,
    amount integer NOT NULL,
    keyset_id text NOT NULL,
    c bytea,
    dleq_e text,
    dleq_s text,
    quote_id text,
    created_time integer DEFAULT 0 NOT NULL,
    signed_time integer,
    operation_kind text,
    operation_id text,
    order_index integer DEFAULT 0
);
CREATE TABLE completed_operations (
    operation_id text NOT NULL,
    operation_kind text NOT NULL,
    completed_at bigint NOT NULL,
    total_issued bigint NOT NULL,
    total_redeemed bigint NOT NULL,
    fee_collected bigint NOT NULL,
    payment_amount bigint,
    payment_fee bigint,
    payment_method text
);
CREATE TABLE keyset (
    id text NOT NULL,
    unit text NOT NULL,
    active boolean NOT NULL,
    valid_from integer NOT NULL,
    valid_to integer,
    derivation_path text NOT NULL,
    input_fee_ppk integer,
    derivation_path_index integer,
    amounts text,
    issuer_version text
);
CREATE TABLE keyset_amounts (
    keyset_id text NOT NULL,
    total_issued bigint DEFAULT 0 NOT NULL,
    total_redeemed bigint DEFAULT 0 NOT NULL,
    fee_collected bigint DEFAULT 0 NOT NULL
);
CREATE TABLE keyset_epoch (
    id integer NOT NULL,
    epoch bigint NOT NULL
);
CREATE TABLE kv_store (
    primary_namespace text NOT NULL,
    secondary_namespace text NOT NULL,
    key text NOT NULL,
    value bytea NOT NULL,
    created_time bigint NOT NULL,
    updated_time bigint NOT NULL
);
CREATE TABLE melt_quote (
    id text NOT NULL,
    unit text NOT NULL,
    amount integer NOT NULL,
    request text NOT NULL,
    fee_reserve integer NOT NULL,
    expiry integer NOT NULL,
    state text DEFAULT 'UNPAID'::text NOT NULL,
    payment_proof text,
    request_lookup_id text,
    created_time integer DEFAULT 0 NOT NULL,
    paid_time integer,
    payment_method text DEFAULT 'bolt11'::text NOT NULL,
    options text,
    request_lookup_id_kind text,
    estimated_blocks integer,
    fee_options text,
    extra_json text,
    selected_fee_index integer,
    CONSTRAINT melt_quote_state_check CHECK ((state = ANY (ARRAY['UNPAID'::text, 'PENDING'::text, 'PAID'::text])))
);
CREATE TABLE melt_request (
    quote_id text NOT NULL,
    inputs_amount integer NOT NULL,
    inputs_fee integer NOT NULL
);
CREATE TABLE mint_quote (
    id text NOT NULL,
    amount integer,
    unit text NOT NULL,
    request text NOT NULL,
    expiry integer NOT NULL,
    request_lookup_id text,
    pubkey text,
    created_time integer DEFAULT 0 NOT NULL,
    amount_paid integer DEFAULT 0 NOT NULL,
    amount_issued integer DEFAULT 0 NOT NULL,
    payment_method text DEFAULT 'BOLT11'::text NOT NULL,
    request_lookup_id_kind text DEFAULT 'payment_hash'::text NOT NULL,
    extra_json text,
    updated_at bigint DEFAULT 0 NOT NULL,
    last_checked bigint DEFAULT 0 NOT NULL
);
CREATE TABLE mint_quote_issued (
    id integer NOT NULL,
    quote_id text NOT NULL,
    amount integer NOT NULL,
    "timestamp" integer NOT NULL
);
CREATE SEQUENCE mint_quote_issued_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE mint_quote_issued_id_seq OWNED BY mint_quote_issued.id;
CREATE TABLE mint_quote_payments (
    id integer NOT NULL,
    quote_id text NOT NULL,
    payment_id text NOT NULL,
    "timestamp" integer NOT NULL,
    amount integer NOT NULL
);
CREATE SEQUENCE mint_quote_payments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE mint_quote_payments_id_seq OWNED BY mint_quote_payments.id;
CREATE TABLE proof (
    y bytea NOT NULL,
    amount integer NOT NULL,
    keyset_id text NOT NULL,
    secret text NOT NULL,
    c bytea NOT NULL,
    witness text,
    state text NOT NULL,
    quote_id text,
    created_time integer DEFAULT 0 NOT NULL,
    operation_kind text,
    operation_id text,
    CONSTRAINT proof_state_check CHECK ((state = ANY (ARRAY['SPENT'::text, 'PENDING'::text, 'UNSPENT'::text, 'RESERVED'::text, 'UNKNOWN'::text])))
);
CREATE TABLE saga_state (
    operation_id text NOT NULL,
    operation_kind text NOT NULL,
    state text NOT NULL,
    quote_id text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    finalization_data text
);
ALTER TABLE ONLY mint_quote_issued ALTER COLUMN id SET DEFAULT nextval('mint_quote_issued_id_seq'::regclass);
ALTER TABLE ONLY mint_quote_payments ALTER COLUMN id SET DEFAULT nextval('mint_quote_payments_id_seq'::regclass);
ALTER TABLE ONLY blind_signature
    ADD CONSTRAINT blind_signature_pkey PRIMARY KEY (blinded_message);
ALTER TABLE ONLY completed_operations
    ADD CONSTRAINT completed_operations_pkey PRIMARY KEY (operation_id);
ALTER TABLE ONLY keyset_amounts
    ADD CONSTRAINT keyset_amounts_pkey PRIMARY KEY (keyset_id);
ALTER TABLE ONLY keyset_epoch
    ADD CONSTRAINT keyset_epoch_pkey PRIMARY KEY (id);
ALTER TABLE ONLY keyset
    ADD CONSTRAINT keyset_pkey PRIMARY KEY (id);
ALTER TABLE ONLY kv_store
    ADD CONSTRAINT kv_store_pkey PRIMARY KEY (primary_namespace, secondary_namespace, key);
ALTER TABLE ONLY melt_quote
    ADD CONSTRAINT melt_quote_pkey PRIMARY KEY (id);
ALTER TABLE ONLY melt_request
    ADD CONSTRAINT melt_request_pkey PRIMARY KEY (quote_id);
ALTER TABLE ONLY mint_quote_issued
    ADD CONSTRAINT mint_quote_issued_pkey PRIMARY KEY (id);
ALTER TABLE ONLY mint_quote_payments
    ADD CONSTRAINT mint_quote_payments_payment_id_key UNIQUE (payment_id);
ALTER TABLE ONLY mint_quote_payments
    ADD CONSTRAINT mint_quote_payments_pkey PRIMARY KEY (id);
ALTER TABLE ONLY mint_quote
    ADD CONSTRAINT mint_quote_pkey PRIMARY KEY (id);
ALTER TABLE ONLY mint_quote
    ADD CONSTRAINT mint_quote_request_lookup_id_key UNIQUE (request_lookup_id);
ALTER TABLE ONLY proof
    ADD CONSTRAINT proof_pkey PRIMARY KEY (y);
ALTER TABLE ONLY saga_state
    ADD CONSTRAINT saga_state_pkey PRIMARY KEY (operation_id);
CREATE INDEX active_index ON keyset USING btree (active);
CREATE INDEX blind_signature_quote_id_index ON blind_signature USING btree (quote_id);
CREATE INDEX idx_blind_sig_operation_id ON blind_signature USING btree (operation_kind, operation_id);
CREATE INDEX idx_completed_operations_kind_time ON completed_operations USING btree (operation_kind, completed_at);
CREATE INDEX idx_completed_operations_time ON completed_operations USING btree (completed_at);
CREATE INDEX idx_kv_store_namespaces ON kv_store USING btree (primary_namespace, secondary_namespace);
CREATE INDEX idx_kv_store_updated_time ON kv_store USING btree (updated_time);
CREATE INDEX idx_melt_quote_request_lookup_id ON melt_quote USING btree (request_lookup_id);
CREATE INDEX idx_melt_quote_request_lookup_id_and_kind ON melt_quote USING btree (request_lookup_id, request_lookup_id_kind);
CREATE INDEX idx_mint_quote_created_time ON mint_quote USING btree (created_time);
CREATE INDEX idx_mint_quote_expiry ON mint_quote USING btree (expiry);
CREATE INDEX idx_mint_quote_issued_quote_id ON mint_quote_issued USING btree (quote_id);
CREATE INDEX idx_mint_quote_payments_payment_id ON mint_quote_payments USING btree (payment_id);
CREATE INDEX idx_mint_quote_payments_quote_id ON mint_quote_payments USING btree (quote_id);
CREATE INDEX idx_mint_quote_request_lookup_id ON mint_quote USING btree (request_lookup_id);
CREATE INDEX idx_mint_quote_request_lookup_id_and_kind ON mint_quote USING btree (request_lookup_id, request_lookup_id_kind);
CREATE INDEX idx_proof_operation_id ON proof USING btree (operation_kind, operation_id);
CREATE INDEX idx_proof_state_operation ON proof USING btree (state, operation_kind);
CREATE INDEX idx_saga_state_operation_kind ON saga_state USING btree (operation_kind);
CREATE INDEX idx_saga_state_quote_id ON saga_state USING btree (quote_id);
CREATE INDEX melt_quote_state_index ON melt_quote USING btree (state);
CREATE UNIQUE INDEX unique_mint_quote_request ON mint_quote USING btree (request);
CREATE UNIQUE INDEX unique_pending_paid_lookup_id ON melt_quote USING btree (request_lookup_id) WHERE (state = ANY (ARRAY['PENDING'::text, 'PAID'::text]));
CREATE INDEX unit_index ON keyset USING btree (unit);
ALTER TABLE ONLY melt_request
    ADD CONSTRAINT melt_request_quote_id_fkey FOREIGN KEY (quote_id) REFERENCES melt_quote(id);
ALTER TABLE ONLY mint_quote_issued
    ADD CONSTRAINT mint_quote_issued_quote_id_fkey FOREIGN KEY (quote_id) REFERENCES mint_quote(id);
ALTER TABLE ONLY mint_quote_payments
    ADD CONSTRAINT mint_quote_payments_quote_id_fkey FOREIGN KEY (quote_id) REFERENCES mint_quote(id);

CREATE TABLE migrations (
    name text PRIMARY KEY,
    applied_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO migrations (name) VALUES
  ('1_initial.sql'),
  ('2_remove_request_lookup_kind_constraints.sql'),
  ('20250901090000_add_kv_store.sql'),
  ('20250902140000_add_melt_request_and_blinded_messages.sql'),
  ('20250903200000_add_signatory_amounts.sql'),
  ('20250916221000_drop_config_table.sql'),
  ('20250924215800_migrate_blinded_messages_to_blind_signatures.sql'),
  ('20251010144317_add_saga_support.sql'),
  ('20251102000000_create_keyset_amounts.sql'),
  ('20251119000000_add_completed_operations.sql'),
  ('20251120000000_add_keyset_fee_collected.sql'),
  ('20251122000000_drop_max_order.sql'),
  ('20251127000000_allow_duplicate_melt_request_lookup_id.sql'),
  ('20251223000000_remove_saga_redundant_columns.sql'),
  ('20260122000000_add_issuer_version_to_keyset.sql'),
  ('20260219000000_clean_oversized_witness_and_secret.sql'),
  ('20260316000000_add_extra_json_to_mint_quote.sql'),
  ('20260407180000_add_saga_finalization_data.sql'),
  ('20260410000000_rename_payment_preimage.sql'),
  ('20260412200000_add_estimated_blocks_to_melt_quote.sql'),
  ('20260416000000_unique_mint_quote_request.sql'),
  ('20260418000000_add_extra_json_to_melt_quote.sql'),
  ('20260427000000_fix_melt_quote_kind_index.sql'),
  ('20260512120000_add_order_index_to_blind_signatures.sql'),
  ('20260520120000_rename_selected_estimated_blocks_to_fee_index.sql'),
  ('20260630000000_add_updated_at_to_mint_quote.sql'),
  ('20260728000000_add_keyset_epoch.sql'),
  ('20260811000000_add_last_checked_to_mint_quote.sql');
