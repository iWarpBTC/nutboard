<p align="center"><img src="public/logo.webp" width="480" alt="nutboard: a squirrel in a fedora examining nuts with a magnifying glass"></p>

# nutboard

A small, self-hosted web dashboard that shows statistics for a
[Nutshell](https://github.com/cashubtc/nutshell) Cashu mint by reading its PostgreSQL
database. It **never writes** to the mint database: it connects with a SELECT-only
role, forces every session into read-only mode, and refuses to start if PostgreSQL
reports anything else.

Because ecash is blind-signed, the mint cannot know who holds which notes. Everything
shown here is derived from what the ledger does record: issued blind signatures,
spent proofs, mint/melt quotes, keyset balances and the mint's own balance log.

## What it shows

- **Outstanding ecash** (issued − redeemed) as the headline, plus issued/redeemed
  totals, pending proofs, input fees collected, Lightning fees paid, and the reserve
  margin from the latest `balance_log` entry.
- **Activity by time window** (24 h / 7 d / 30 d / all time): minted, melted and
  swapped volumes and counts, blind signatures, proofs spent, mint-request
  conversion, Lightning fees and average/largest operations.
- **Activity over time**: minted / melted / swapped per bucket (hourly to monthly
  depending on the selected range), switchable between amount and count.
- **Lightning fees by payment size**: paid melts grouped by order of magnitude of the
  amount, with the routing fee the node paid (volume-weighted and median, in % and ppm),
  the ecash input fee the mint kept, the reserve wallets were asked for and the share
  of fee-free payments, so that tiny auditor payments do not distort the picture.
- **Last operation** (mint / melt / swap) at the top, with the time since each.
- The footer names the running version and commit (`deploy/push.sh` records it in `build.json`).
- **Reserves**: Lightning backend balance vs outstanding ecash over time.
- **Activity by hour of day** in the mint's local time.
- **Outstanding notes by denomination** (signed outputs minus spent proofs per amount).
- **Quote states** for mint and melt quotes.
- **Audit checks**: keyset balance counters vs the ledger, backend reserve coverage,
  issued quotes vs signed outputs, melt input/output accounting, stuck pending
  proofs or melts, paid-but-unclaimed mint quotes, orphaned rows, stale unsigned outputs.
- **Keysets** with per-keyset issued/redeemed/pending/balance/fees.
- **Recent activity** feed of completed operations.

Every chart has a table view, and the page supports light and dark mode.

## Sign-in: passkeys only

The dashboard opens with a **passkey**: Face ID / Touch ID, stored in iCloud Keychain and synced to your Apple
devices. There is no password, no e-mail and no reset.

- **First start**: with no passkey yet, the server prints a one-time **setup code** to its log. Open the site, enter
  the code and confirm with Face ID. Setup is then closed for good; the code can't be used again.
- **Every visit**: *Sign in with passkey* → Face ID. Sessions last at most 30 days and end after 7 days unused;
  the *Security* card at the bottom signs out here or everywhere.
- **More devices**: Apple devices get the passkey through iCloud Keychain. Others can sign in with the iPhone
  (QR code) or get their own passkey under *Security → Add passkey* while signed in.
- **Lost every passkey**: only someone with shell access to the server can start over:
  `npm run auth:reset -- --yes`, restart, and use the new setup code from the log.
- A passkey works only on the domain it was made for. A dashboard moved to a new address asks for setup there.
- **Local development** can skip sign-in with `NUTBOARD_AUTH=off`; the server refuses that unless it is bound to
  loopback with a localhost origin.

Under the hood: WebAuthn with user verification required and discoverable credentials, verified by
[`@simplewebauthn/server`](https://simplewebauthn.dev). Passkeys and sessions live in a small SQLite file
(`AUTH_DB`, default `data/nutboard.db`), never in the mint database. The session cookie is random, `HttpOnly`,
`SameSite=Strict` (`__Host-` and `Secure` on HTTPS) and only its SHA-256 is stored. Every write must come from the
app's own origin, the Host header is checked (no DNS rebinding) and responses carry a strict Content-Security-Policy.

Nutshell does not record a swap id, so "swaps" are approximated by grouping the
outputs stored within the same second. Minted and melted figures are exact.

## Requirements

- Node.js 22.18 or newer (TypeScript is run directly, no build step; the built-in SQLite holds passkeys).
- Network access to the mint's PostgreSQL database (PostgreSQL 14 or newer).
- A Nutshell database at migration 20 or later (Nutshell 0.16+). Newer columns are
  used when present, so older schemas degrade gracefully.

## Setup

### 1. Create a read-only database role

Run the script as the PostgreSQL superuser **inside the mint database**. On the database
host the `postgres` OS user needs no password (peer authentication over the Unix socket):

```bash
su - postgres -c "psql -d mint -f $PWD/scripts/create-readonly-role.sql"
```

(`su - postgres -c "psql -l"` lists the databases if the mint's is not called `mint`.)
The first run creates `nutboard_ro` with a random password and prints a ready-made
`DATABASE_URL=...` line for your `.env`. The role gets `SELECT` on every mint table except
the keyset secrets (`seed`, `encrypted_seed`, `seed_encryption_method`), no write
privileges, and `default_transaction_read_only = on` at the role level. Re-run the script
after upgrading Nutshell so tables added by new migrations are covered; it keeps the
password and refuses to run in a database without a `keysets` table. Without any
password, PostgreSQL's peer authentication can map the service user to the role and the
app connects over the Unix socket (`postgres://nutboard_ro@/mint?host=/var/run/postgresql`,
see [deploy/README.md](deploy/README.md)).

### 2. Configure

```bash
cp .env.example .env
# then edit DATABASE_URL and MINT_TZ
```

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | required | PostgreSQL URL, e.g. `postgres://nutboard_ro:pw@host:5432/mint` (add `?sslmode=require` for TLS) |
| `MINT_TZ` | `UTC` | IANA time zone the **mint process** writes timestamps in. Nutshell stores naive local time: `UTC` for a containerized mint, the host's zone otherwise. nutboard warns at startup and in the status bar when the newest ledger row lands in the future or looks like UTC |
| `ORIGIN` | `http://localhost:PORT` | The exact public address, e.g. `https://nutboard.lnpay.cz` (required online; passkeys are bound to it) |
| `HOST` / `PORT` | `127.0.0.1` / `3737` | Bind address and port; `HOST=0.0.0.0` inside a container behind the HTTPS proxy |
| `AUTH_DB` | `data/nutboard.db` | SQLite file for passkeys and sessions; keep it on persistent storage, never in a web root |
| `SETUP_CODE` | random | Optional fixed setup code (≥ 12 characters) instead of the random one in the log |
| `NUTBOARD_AUTH` | on | `off` disables sign-in; refused unless the app is local only (`localhost` + loopback) |
| `PG_SCHEMA` | `public` | Schema holding the Nutshell tables |
| `MINT_NAME` | `Nutshell mint` | Name shown in the header and as the passkey's site name |
| `CACHE_TTL_SECONDS` | `30` | How long computed statistics are reused before re-querying |
| `STATEMENT_TIMEOUT_MS` | `30000` | Server-side statement timeout for every query |
| `PG_POOL_MAX` | `4` | Connection pool size |

### 3. Run

```bash
npm install
npm start
```

Open http://localhost:3737 and enter the setup code from the server log. Passkeys need HTTPS and a stable
address online (localhost is fine for development), so a reverse proxy with TLS goes in front; it must pass the
original `Host` header.

**Step by step for a VPS with nginx (nutboard.lnpay.cz): [deploy/README.md](deploy/README.md)** — a systemd
service, the nginx site and `deploy/push.sh` for updates.

### Docker

```bash
docker build -t nutboard --build-arg GIT_COMMIT=$(git rev-parse --short HEAD) .
docker run --rm -p 3737:3737 -v nutboard-auth:/data \
  -e DATABASE_URL=postgres://nutboard_ro:pw@db-host:5432/mint \
  -e ORIGIN=https://nutboard.example.com -e AUTH_DB=/data/nutboard.db \
  -e MINT_TZ=UTC -e HOST=0.0.0.0 nutboard
```

## How "read-only" is enforced

1. **Database role**: `scripts/create-readonly-role.sql` grants `SELECT` only and sets
   `default_transaction_read_only = on` for the role.
2. **Connection startup parameters**: every connection is opened with
   `default_transaction_read_only=on`, a `statement_timeout`, `TimeZone=UTC` and the
   configured `search_path`, so sessions are read-only before the first statement.
3. **Startup verification**: the server asks PostgreSQL whether the session really is
   read-only and exits if it is not. It also warns if the role holds any
   INSERT/UPDATE/DELETE privilege or is a superuser.
4. **Code**: the application issues `SELECT` statements only, through parameterized
   queries, and never selects keyset seed columns.

If a write were ever attempted, PostgreSQL rejects it with
`cannot execute INSERT in a read-only transaction`.

## JSON API

The dashboard is a static page over a small JSON API. Everything except `/api/auth/*` needs the session
cookie (all endpoints are `GET`; `unit` defaults to `sat`):

| Endpoint | Description |
|---|---|
| `/api/auth/status` | whether a passkey exists and whether this session is signed in (public) |
| `/api/health` | connection, read-only status, Nutshell db version |
| `/api/units` | units found in `keysets` |
| `/api/overview?unit=` | windowed counts/volumes, liabilities, quote states, last balance log |
| `/api/timeseries?unit=&range=24h\|7d\|30d\|90d\|1y\|all` | minted / melted / swapped per bucket |
| `/api/fees?unit=&range=` | Lightning routing fees and mint input fees by payment size |
| `/api/keysets` | per-keyset ledger figures |
| `/api/denominations?unit=` | issued / spent / pending / outstanding per amount |
| `/api/balance-log?unit=&range=` | backend vs keyset balance history |
| `/api/hourly?unit=` | operations by hour of day (last 30 days, mint local time) |
| `/api/activity?unit=&limit=` | recent completed operations |
| `/api/audit?unit=` | consistency checks |

All timestamps in responses are UTC ISO strings. Amounts are in the unit's smallest
denomination (sat, or cents for `usd`/`eur`), as stored by Nutshell.

## Development

A fixture database that looks like a busy mint can be generated locally. The seed
script **writes** to the database it is pointed at, so it refuses any database whose
name does not contain `dev`, `test` or `fixture`.

```bash
createdb nutboard_dev
DEV_DATABASE_URL=postgres://localhost:5432/nutboard_dev npm run seed:dev
psql -d nutboard_dev -f scripts/create-readonly-role.sql  # prints DATABASE_URL for .env; re-run after every seed
# .env: DATABASE_URL=postgres://nutboard_ro:<password>@localhost:5432/nutboard_dev
npm run dev
```

`npm run typecheck` runs the TypeScript compiler and `npm test` the test suite; with `TEST_DATABASE_URL` set to
the fixture database the HTTP tests run too. `scripts/dev-schema.sql` mirrors the Nutshell mint schema at
migration 40 and is only used by the seed script. `NUTBOARD_AUTH=off npm run dev` skips sign-in locally.

## Fixing inconsistencies

The audit checks find problems; they never change anything. Each finding lists the offending records and a remedy
in the dashboard, and the common cases are collected here. Before any edit: **stop the mint**, take a backup
(`pg_dump`), connect with a role that may write (the mint's own, not `nutboard_ro`), make the change in one
transaction, start the mint, and re-check in nutboard. A database with years of history will show a few of these;
they are almost always the trace of a crash or an old bug, not a loss.

### What is normal on an old database

- **Legacy rows.** Nutshell links outputs to their mint quote and spent proofs to their melt quote only since
  migration 17 (mid-2024), and melt change outputs since migration 28. Older rows have no link, so their origin is
  unknown: nutboard counts them as *legacy* instead of swaps, and the "issued quotes equal signed outputs" check
  only covers quotes issued after the first linked output. Nothing to fix.
- **Paid, unclaimed mint quotes.** The invoice was paid but the wallet never fetched the ecash. The sats are on your
  node and the quote stays claimable.
- **Unsigned outputs.** A mint or swap stored the wallet's outputs and failed before signing them. Harmless; delete
  them if you like a clean table:
  ```sql
  DELETE FROM promises WHERE c_ IS NULL AND melt_quote IS NULL AND created < now()::timestamp - interval '1 day';
  ```

### Keyset balance counter differs from the ledger

`keysets.balance` is a running counter (since migration 27) that the mint debits when proofs are reserved or spent
and credits when outputs are signed or a reservation is released; `try_debit_keyset_balance` refuses redemptions
beyond it. The ledger value it should equal is signed outputs − spent proofs − pending proofs, which is exactly how
the column was seeded. A counter *below* the ledger can make the mint refuse the last few sats of valid ecash on that
keyset; a counter *above* it weakens an internal safety check. Neither affects anyone's funds. Reset it to the ledger:

```sql
UPDATE keysets k SET balance =
    (SELECT coalesce(sum(amount), 0) FROM promises WHERE id = k.id AND c_ IS NOT NULL)
  - (SELECT coalesce(sum(amount), 0) FROM proofs_used WHERE id = k.id)
  - (SELECT coalesce(sum(amount), 0) FROM proofs_pending WHERE id = k.id)
WHERE k.id IN ('<keyset id>', '<keyset id>');
```

### A melt quote stuck in PENDING (and its pending proofs)

A pending melt is an outgoing Lightning payment whose outcome the mint does not know. The wallet's inputs stay in
`proofs_pending` and the keyset counter has already been debited for them. **Restart the mint first**: at startup it
asks the backend about every pending melt and commits (settled) or rolls back (failed) by itself. Payments the backend
reports as *pending*, *not found* or that error out stay pending for ever, so look the `payment_hash` up on your node
(`lncli trackpayment <hash>`, `lightning-cli listpays <hash>`, ...) and resolve by hand.

If the node says the payment **failed or never existed**, do what Nutshell's rollback does (release the proofs, credit
the counter back, forget the unsigned change outputs, reopen the quote):

```sql
BEGIN;
UPDATE keysets k SET balance = balance + (SELECT coalesce(sum(amount), 0) FROM proofs_pending WHERE melt_quote = '<quote>' AND id = k.id)
 WHERE k.id IN (SELECT DISTINCT id FROM proofs_pending WHERE melt_quote = '<quote>');
DELETE FROM proofs_pending WHERE melt_quote = '<quote>';
DELETE FROM promises WHERE melt_quote = '<quote>' AND c_ IS NULL;
UPDATE melt_quotes SET state = 'UNPAID' WHERE quote = '<quote>';
COMMIT;
```

The wallet can then spend those notes again (it may need a *check proofs* / restore in the wallet).

If the node says the payment **succeeded**, do what Nutshell's commit does (spend the proofs, record the fee and
preimage). The counter stays as it is: the reservation already debited it.

```sql
BEGIN;
INSERT INTO proofs_used (amount, id, c, secret, y, witness, created, melt_quote)
  SELECT amount, id, c, secret, y, witness, now()::timestamp, melt_quote FROM proofs_pending WHERE melt_quote = '<quote>';
DELETE FROM proofs_pending WHERE melt_quote = '<quote>';
UPDATE melt_quotes SET state = 'PAID', paid_time = now()::timestamp, fee_paid = <fee in sat>, proof = '<preimage>' WHERE quote = '<quote>';
COMMIT;
```

Change for an overpaid fee reserve cannot be returned by hand (the mint signs change only in its own flow); the
difference stays with the mint, which is what a wallet expects of a failed change.

### Pending proofs without a melt quote

A swap crashed between reserving its inputs and finishing. Release them the way Nutshell's rollback does:

```sql
BEGIN;
UPDATE keysets k SET balance = balance + (SELECT coalesce(sum(amount), 0) FROM proofs_pending WHERE melt_quote IS NULL AND id = k.id)
 WHERE k.id IN (SELECT DISTINCT id FROM proofs_pending WHERE melt_quote IS NULL);
DELETE FROM proofs_pending WHERE melt_quote IS NULL;
COMMIT;
```

### Backend reserve check skipped

Nutshell's ledger watchdog writes a `balance_log` row whenever it compares the Lightning backend balance with the
keyset balances; enable it in the mint's settings to get the reserve check (it shuts the mint down on a mismatch
unless `MINT_WATCHDOG_IGNORE_MISMATCH` is set).

## Notes on the data model

- `promises` holds every blind signature the mint produced (`c_ IS NULL` rows are
  blinded messages that were stored but never signed, typically unused melt change
  outputs). `mint_quote` / `melt_quote` link outputs to their quote; outputs with
  neither are swap outputs.
- `proofs_used` holds spent proofs; `melt_quote` is set when they were spent in a
  melt, otherwise they were spent in a swap. `proofs_pending` holds proofs reserved
  by an in-flight operation.
- `keysets.balance` is maintained by the mint as issued − redeemed − pending, and
  `keysets.fees_paid` accumulates input fees. The audit checks recompute both from
  the ledger.
- `balance_log` is written by the mint when it reconciles its Lightning backend
  balance against outstanding ecash.
