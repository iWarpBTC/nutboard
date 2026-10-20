-- Nutshell mint schema as produced by cashu/mint/migrations.py (migration 40) on PostgreSQL.
-- FOR LOCAL DEVELOPMENT ONLY: this file is used by scripts/seed-dev.ts to build a fixture
-- database. Never run it against a real mint.

DROP VIEW IF EXISTS balance;
DROP VIEW IF EXISTS balance_issued;
DROP VIEW IF EXISTS balance_redeemed;
DROP TABLE IF EXISTS balance_log;
DROP TABLE IF EXISTS proofs_pending;
DROP TABLE IF EXISTS proofs_used;
DROP TABLE IF EXISTS promises;
DROP TABLE IF EXISTS melt_quotes;
DROP TABLE IF EXISTS mint_quotes;
DROP TABLE IF EXISTS mint_pubkeys;
DROP TABLE IF EXISTS keysets;
DROP TABLE IF EXISTS dbversions;

CREATE TABLE dbversions (
  db TEXT PRIMARY KEY,
  version INT NOT NULL
);

CREATE TABLE keysets (
  id TEXT NOT NULL,
  derivation_path TEXT,
  seed TEXT,
  valid_from TIMESTAMP,
  valid_to TIMESTAMP,
  first_seen TIMESTAMP,
  active BOOL DEFAULT TRUE,
  version TEXT,
  unit TEXT,
  encrypted_seed TEXT,
  seed_encryption_method TEXT,
  input_fee_ppk INTEGER,
  amounts TEXT,
  balance INTEGER NOT NULL DEFAULT 0,
  fees_paid INTEGER NOT NULL DEFAULT 0,
  final_expiry INTEGER NULL,
  UNIQUE (id)
);

CREATE TABLE mint_pubkeys (
  id TEXT NOT NULL,
  amount BIGINT NOT NULL,
  pubkey TEXT NOT NULL,
  UNIQUE (id, pubkey)
);

CREATE TABLE mint_quotes (
  quote TEXT NOT NULL,
  method TEXT NOT NULL,
  request TEXT NOT NULL,
  checking_id TEXT NOT NULL,
  unit TEXT NOT NULL,
  amount BIGINT NOT NULL,
  created_time TIMESTAMP,
  paid_time TIMESTAMP,
  state TEXT,
  pubkey TEXT DEFAULT NULL,
  issued_time TIMESTAMP,
  last_checked TIMESTAMP NULL,
  amount_paid BIGINT DEFAULT NULL,
  amount_issued BIGINT DEFAULT NULL,
  updated_at TIMESTAMP DEFAULT NULL,
  UNIQUE (quote)
);

CREATE TABLE melt_quotes (
  quote TEXT NOT NULL,
  method TEXT NOT NULL,
  request TEXT NOT NULL,
  checking_id TEXT NOT NULL,
  unit TEXT NOT NULL,
  amount BIGINT NOT NULL,
  fee_reserve BIGINT,
  created_time TIMESTAMP,
  paid_time TIMESTAMP,
  fee_paid BIGINT,
  proof TEXT,
  state TEXT,
  expiry TIMESTAMP,
  attempt TEXT NOT NULL DEFAULT '',
  UNIQUE (quote)
);

CREATE TABLE promises (
  amount BIGINT NOT NULL,
  id TEXT,
  b_ TEXT NOT NULL,
  c_ TEXT,
  created TIMESTAMP,
  mint_quote TEXT,
  swap_id TEXT,
  melt_quote TEXT,
  signed_at TIMESTAMP,
  order_index INTEGER DEFAULT 0,
  FOREIGN KEY (mint_quote) REFERENCES mint_quotes(quote),
  CONSTRAINT fk_promises_melt_quote FOREIGN KEY (melt_quote) REFERENCES melt_quotes(quote),
  UNIQUE (b_)
);

CREATE TABLE proofs_used (
  amount BIGINT NOT NULL,
  id TEXT,
  c TEXT NOT NULL,
  secret TEXT NOT NULL,
  y TEXT,
  witness TEXT,
  created TIMESTAMP,
  melt_quote TEXT,
  FOREIGN KEY (melt_quote) REFERENCES melt_quotes(quote),
  UNIQUE (y)
);

CREATE TABLE proofs_pending (
  amount BIGINT NOT NULL,
  id TEXT,
  c TEXT NOT NULL,
  secret TEXT NOT NULL,
  y TEXT,
  witness TEXT,
  created TIMESTAMP,
  melt_quote TEXT,
  FOREIGN KEY (melt_quote) REFERENCES melt_quotes(quote),
  UNIQUE (y)
);

CREATE INDEX IF NOT EXISTS proofs_used_idx ON proofs_used (secret);
CREATE INDEX IF NOT EXISTS proofs_used_y_idx ON proofs_used (y);
CREATE INDEX IF NOT EXISTS proofs_pending_y_idx ON proofs_pending (y);

CREATE TABLE balance_log (
  unit TEXT NOT NULL,
  keyset_balance INTEGER NOT NULL,
  keyset_fees_paid INTEGER NOT NULL,
  backend_balance INTEGER NOT NULL,
  time TIMESTAMP DEFAULT now()
);

CREATE VIEW balance_issued AS
  SELECT id AS keyset, COALESCE(s, 0) AS balance FROM (
    SELECT id, SUM(amount) AS s FROM promises WHERE amount > 0 AND c_ IS NOT NULL GROUP BY id
  ) AS balance_issued;

CREATE VIEW balance_redeemed AS
  SELECT id AS keyset, COALESCE(s, 0) AS balance FROM (
    SELECT id, SUM(amount) AS s FROM proofs_used WHERE amount > 0 GROUP BY id
  ) AS balance_redeemed;

CREATE VIEW balance AS
  SELECT keyset, s_issued - s_used AS balance FROM (
    SELECT bi.keyset AS keyset, bi.balance AS s_issued, COALESCE(bu.balance, 0) AS s_used
      FROM balance_issued bi LEFT OUTER JOIN balance_redeemed bu ON bi.keyset = bu.keyset
  ) AS balance;

INSERT INTO dbversions (db, version) VALUES ('mint', 40);
