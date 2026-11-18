-- The part of an LNbits 1.7 database (PostgreSQL) that nutboard reads, plus the secret columns next to it
-- so that the column grants of scripts/create-readonly-role.sql have something to leave out.
-- FOR LOCAL DEVELOPMENT ONLY: this file is used by scripts/seed-dev-lnbits.ts to build a fixture
-- database. Never run it against a real LNbits.

DROP VIEW IF EXISTS balances;
DROP TABLE IF EXISTS apipayments;
DROP TABLE IF EXISTS wallets;
DROP TABLE IF EXISTS accounts;
DROP TABLE IF EXISTS dbversions;

CREATE TABLE dbversions (
  db TEXT PRIMARY KEY,
  version INTEGER NOT NULL
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT,
  password_hash TEXT,
  username TEXT,
  extra TEXT,
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  pubkey TEXT,
  activated BOOLEAN
);

CREATE TABLE wallets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  "user" TEXT NOT NULL,
  adminkey TEXT NOT NULL,
  inkey TEXT,
  currency TEXT,
  deleted BOOLEAN DEFAULT false,
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  extra TEXT,
  wallet_type TEXT DEFAULT 'lightning',
  shared_wallet_id TEXT
);

CREATE TABLE apipayments (
  checking_id TEXT NOT NULL,
  amount BIGINT NOT NULL,
  fee INTEGER NOT NULL DEFAULT 0,
  wallet_id TEXT NOT NULL,
  memo TEXT,
  time TIMESTAMP,
  payment_hash TEXT,
  preimage TEXT,
  bolt11 TEXT,
  extra TEXT,
  webhook TEXT,
  webhook_status TEXT,
  expiry TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'pending',
  tag TEXT,
  extension TEXT,
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  UNIQUE (wallet_id, checking_id)
);

-- As in LNbits: settled incoming payments, settled and pending outgoing ones, fees taken off.
CREATE VIEW balances AS
SELECT apipayments.wallet_id, sum(apipayments.amount - abs(apipayments.fee)) AS balance
  FROM wallets LEFT JOIN apipayments ON apipayments.wallet_id = wallets.id
 WHERE (wallets.deleted = false OR wallets.deleted IS NULL)
   AND ((apipayments.status = 'success' AND apipayments.amount > 0)
     OR (apipayments.status IN ('success', 'pending') AND apipayments.amount < 0))
 GROUP BY apipayments.wallet_id;

INSERT INTO dbversions (db, version) VALUES ('core', 42);
