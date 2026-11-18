<p align="center"><img src="public/logo.webp" width="480" alt="nutboard: a squirrel in a fedora examining nuts with a magnifying glass"></p>

# nutboard

A small, self-hosted web dashboard that shows statistics for a Cashu mint by reading its
PostgreSQL database. It understands the databases of
[Nutshell](https://github.com/cashubtc/nutshell) and of [CDK](https://github.com/cashubtc/cdk)
(`cdk-mintd`) and tells them apart by their tables. One dashboard can show several mints side by
side and, optionally, an LNbits instance. It **never writes** to a mint or LNbits database: it connects with a SELECT-only
role, forces every session into read-only mode, and refuses to start if PostgreSQL
reports anything else.

Because ecash is blind-signed, the mint cannot know who holds which notes. Everything
shown here is derived from what the ledger does record: issued blind signatures,
spent proofs, mint/melt quotes, keyset balances and, where the mint keeps them, its
log of finished operations (CDK) or of its backend balance (Nutshell).

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

## Nutshell and CDK

The dashboard looks the same for both; a few figures come from different places.

| | Nutshell | CDK |
|---|---|---|
| Mints, melts, swaps | quotes and outputs; swaps are **approximated** by grouping the outputs stored within the same second | one row per finished operation in `completed_operations`, so swaps are exact |
| Lightning fee of a melt | `melt_quotes.fee_paid` | `completed_operations.payment_fee` |
| Input fees the mint kept | inputs − payment − Lightning fee − change | `completed_operations.fee_collected` |
| The mint's own balance counter | `keysets.balance` | `keyset_amounts` (issued − redeemed, less pending inputs) |
| Reserves chart | from `balance_log` (ledger watchdog) | not available: CDK does not record its backend balance |
| Timestamps | naive local time, `MINT_TZ` must match the mint host | Unix time; `MINT_TZ` only sets the zone of the hour-of-day chart |
| Extra audit checks | | unfinished operations (`saga_state`), operations log against outputs and inputs |

On a CDK database that was imported from Nutshell, the history from before the import has no operations log:
outstanding ecash, keysets and quote states are complete, activity and fee charts start at the import.

## Several mints, LNbits and the kill switch

**Several mints.** List them in `MINTS` and give each its own `MINT_<ID>_DATABASE_URL` (see the table below).
A row of tabs then switches between an overview of everything and each mint in detail. The overview adds up
what is owed in sat across all sources: the figure one Lightning node has to cover if it backs them all.

**LNbits.** With `LNBITS_DATABASE_URL` set, an LNbits tab shows what LNbits owes its wallets, payments per time
window and over time, every wallet with its balance and totals, and recent payments (all of them or one
wallet's). Wallets and accounts can be given names of your own: click the pencil next to one. The names are
kept in nutboard's own SQLite file, never written to LNbits. nutboard reads amounts, times, statuses and who
owns which wallet; the role created by `scripts/create-readonly-role.sql` cannot read API keys, password
hashes, e-mail addresses, invoices, preimages or memos. Developed against LNbits 1.7 on PostgreSQL.

**Kill switch.** Optional, and the only thing nutboard can do besides looking. It stops and disables the
systemd units of the mints, of LNbits, or cuts the tunnel to the Lightning node and then stops both. How it is
built, because this matters:

- nutboard itself stays unprivileged and sandboxed. A request is an empty file with one of four fixed names in
  `KILL_SWITCH_DIR`. A root-owned systemd path unit sees it and runs a small root-owned script
  (`deploy/killswitch/nutboard-kill.sh`) that stops the units listed in a root-owned file. Nothing nutboard
  writes is read as a command or an argument.
- A request needs the exact phrase typed in (`STOP MINTS`, `CUT LND`, …) and a passkey confirmation no older
  than five minutes: a session cookie alone is not enough.
- It works one way. Starting things again takes a root shell on the server, by design.
- Cutting the tunnel from this server does not help if the server itself is taken over; then the peer has to be
  removed on the Lightning node.

Setup is in [deploy/README.md](deploy/README.md). Without `KILL_SWITCH_DIR` the feature does not exist.

## Requirements

- Node.js 22.18 or newer (TypeScript is run directly, no build step; the built-in SQLite holds passkeys).
- Network access to the mint's PostgreSQL database (PostgreSQL 14 or newer).
- A Nutshell database at migration 20 or later (Nutshell 0.16+); newer columns are
  used when present, so older schemas degrade gracefully. Or a CDK mint database
  (`cdk-mintd` on PostgreSQL) with the operations log; developed against the schema of CDK v0.18.3.

## Setup

### 1. Create a read-only database role

Run the script as the PostgreSQL superuser **inside the mint database**. On the database
host the `postgres` OS user needs no password (peer authentication over the Unix socket):

```bash
su - postgres -c "psql -d mint -f $PWD/scripts/create-readonly-role.sql"
```

(`su - postgres -c "psql -l"` lists the databases if the mint's is not called `mint`.)
The first run creates `nutboard_ro` with a random password and prints a ready-made
`DATABASE_URL=...` line for your `.env`. On Nutshell the role gets `SELECT` on every mint table
except the keyset secrets (`seed`, `encrypted_seed`, `seed_encryption_method`). On CDK it gets
only the tables nutboard reads, without the spent secrets, witnesses and DLEQ proofs, and nothing
on `kv_store`, where the mint keeps its configuration. Either way there are no write
privileges and `default_transaction_read_only = on` is set at the role level. Re-run the script
after upgrading the mint so tables added by new migrations are covered; it keeps the
password and refuses to run in a database that is not a mint's. Without any
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
| `DATABASE_URL` | required | PostgreSQL URL, e.g. `postgres://nutboard_ro:pw@host:5432/mint` (add `?sslmode=require` for TLS). Not needed when `MINTS` is set |
| `MINTS` | | Several mints in one dashboard: comma-separated ids, e.g. `old,cdk`. Each id needs `MINT_<ID>_DATABASE_URL` and may have `MINT_<ID>_NAME`, `_TZ`, `_KIND` and `_SCHEMA` (id in upper case, dashes as underscores) |
| `SITE_NAME` | `MINT_NAME` | Name of the dashboard itself (page title, passkey site name) when it shows more than one thing |
| `LNBITS_DATABASE_URL` | | PostgreSQL URL of an LNbits database; adds the LNbits tab. `LNBITS_NAME` (default `LNbits`) and `LNBITS_TZ` (default `UTC`, the zone of the LNbits host) go with it |
| `KILL_SWITCH_DIR` | | Directory watched by the root-side helper, normally `/run/nutboard-kill`; adds the kill switch tab. `KILL_SWITCH_CONF` (default `/etc/nutboard/killswitch.conf`) lists the units |
| `MINT_KIND` | `auto` | `nutshell` or `cdk`; `auto` decides by the tables found in the database |
| `MINT_TZ` | `UTC` | CDK: only the zone of the hour-of-day chart (CDK stores Unix time). Nutshell: IANA time zone the **mint process** writes timestamps in. Nutshell stores naive local time: `UTC` for a containerized mint, the host's zone otherwise. nutboard warns at startup and in the status bar when the newest ledger row lands in the future or looks like UTC |
| `ORIGIN` | `http://localhost:PORT` | The exact public address, e.g. `https://nutboard.lnpay.cz` (required online; passkeys are bound to it) |
| `HOST` / `PORT` | `127.0.0.1` / `3737` | Bind address and port; `HOST=0.0.0.0` inside a container behind the HTTPS proxy |
| `AUTH_DB` | `data/nutboard.db` | SQLite file for passkeys, sessions, wallet names and the kill switch log; keep it on persistent storage, never in a web root |
| `SETUP_CODE` | random | Optional fixed setup code (≥ 12 characters) instead of the random one in the log |
| `NUTBOARD_AUTH` | on | `off` disables sign-in; refused unless the app is local only (`localhost` + loopback) |
| `PG_SCHEMA` | `public` | Schema holding the mint tables |
| `MINT_NAME` | `Cashu mint` | Name shown in the header and as the passkey's site name |
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

This holds for every database nutboard connects to: each mint and LNbits. What nutboard does write is its own
SQLite file (`AUTH_DB`): passkeys, sessions, the names you give LNbits wallets and the kill switch log. The kill
switch, when installed, additionally lets it create request files in one directory; see above for why that cannot
be turned into anything but stopping the listed services.

## JSON API

The dashboard is a static page over a small JSON API. Everything except `/api/auth/*` needs the session
cookie. Everything is `GET` except the two writes at the end; `unit` defaults to `sat` and `mint` to the first mint:

| Endpoint | Description |
|---|---|
| `/api/auth/status` | whether a passkey exists and whether this session is signed in (public) |
| `/api/health` | connection, read-only status, mint kind (`mintKind`), schema version and what the mint offers (`features`) |
| `/api/summary` | every mint and LNbits side by side, and the total owed in sat |
| `/api/units` | units found in the keysets |
| `/api/overview?unit=` | windowed counts/volumes, liabilities, quote states, last balance log |
| `/api/timeseries?unit=&range=24h\|7d\|30d\|90d\|1y\|all` | minted / melted / swapped per bucket |
| `/api/fees?unit=&range=` | Lightning routing fees and mint input fees by payment size |
| `/api/keysets` | per-keyset ledger figures |
| `/api/denominations?unit=` | issued / spent / pending / outstanding per amount |
| `/api/balance-log?unit=&range=` | backend vs keyset balance history (empty on CDK) |
| `/api/hourly?unit=` | operations by hour of day (last 30 days, in `MINT_TZ`) |
| `/api/activity?unit=&limit=` | recent completed operations |
| `/api/audit?unit=` | consistency checks |
| `/api/lnbits/overview`, `/wallets`, `/payments?wallet=&limit=`, `/timeseries?range=` | LNbits balances, wallets and payments |
| `/api/labels` | names given to LNbits wallets and accounts; `PUT` with `{kind, id, name}` sets one |
| `/api/kill` | state of the units the kill switch covers and its log; `POST` with `{target, confirm}` pulls it |

All timestamps in responses are UTC ISO strings. Amounts are in the unit's smallest
denomination (sat, or cents for `usd`/`eur`), as stored by the mint.

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

For a CDK-shaped fixture use `createdb nutboard_cdk_dev` and `npm run seed:dev:cdk` instead; the role script and
everything else are the same, and nutboard picks the dialect from the tables. `npm run seed:dev:lnbits` builds a
small LNbits fixture the same way (database name `nutboard_lnbits_dev`, then the role script, then
`LNBITS_DATABASE_URL`).

`npm run typecheck` runs the TypeScript compiler and `npm test` the test suite; with `TEST_DATABASE_URL` set to
a fixture database (either kind) the HTTP tests and the statistics tests run too, and with
`TEST_LNBITS_DATABASE_URL` the LNbits ones. `scripts/dev-schema.sql` mirrors
the Nutshell mint schema at migration 40, `scripts/dev-schema-cdk.sql` is what CDK v0.18.3's migrations produce;
both are only used by the seed scripts. `NUTBOARD_AUTH=off npm run dev` skips sign-in locally.

The queries live in `src/stats/`: `nutshell.ts` and `cdk.ts` each implement the `MintStats` interface from
`shared.ts`, which also defines the shapes the API returns.

## Fixing inconsistencies

The SQL in this section is for **Nutshell**. A CDK mint keeps more state per operation and repairs unfinished
operations itself when it starts, so there the first remedy is to restart `cdk-mintd`; the dashboard says so next to
each finding and offers no SQL to run.

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
