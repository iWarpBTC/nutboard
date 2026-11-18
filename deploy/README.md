# Deploying to nutboard.lnpay.cz (Debian VPS with nginx)

```
browser ──HTTPS──▶ nginx (nutboard.lnpay.cz, Let's Encrypt) ──▶ node src/server.ts on 127.0.0.1:26545 (user nutboard)
                                                                  ├─ PostgreSQL: the mint database, Nutshell or CDK (read-only role)
                                                                  └─ /var/lib/nutboard/nutboard.db (passkeys + sessions)
```

Nothing goes to `/var/www`: there is no build step and nginx serves no files for this site, it only forwards to the
app. The code lives in `/opt/nutboard` (owned by root, so the app can't change itself), passkeys and sessions in
`/var/lib/nutboard` (outside any web root, readable only by the `nutboard` user). The mint database is only ever read,
through a SELECT-only role whose connection string sits in `/etc/nutboard.env` (root-only).

Commands below run as root on the server unless marked "Mac".

## 1. Node and the nutboard user (once, as root on Debian 13)

Debian 13 ships Node 20, too old for the app (it runs TypeScript natively and uses the built-in SQLite, Node 22.18+),
so Node 24 LTS comes from NodeSource's apt repository. If the server already has it from the invity deployment,
skip to `useradd`.

```sh
apt-get update
apt-get install -y ca-certificates curl gnupg rsync
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --batch --yes -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
apt-get update
apt-get install -y nodejs
node --version                      # v24.x

useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin nutboard
install -d -o root -g root -m 755 /opt/nutboard
install -d -o nutboard -g nutboard -m 700 /var/lib/nutboard
ss -ltn | grep -q ':26545 ' && echo "port 26545 is TAKEN" || echo "port 26545 is free"
```

## 2. The read-only role on the mint database (once)

The script must run **inside the mint database**, as the PostgreSQL superuser. On the database host the `postgres`
OS user signs in without a password (peer authentication over the Unix socket), so the code from step 3 has to be
on the server first, or copy the one file over:

```sh
su - postgres -c "psql -l"                                                              # find the mint database's name
su - postgres -c "psql -d mint -f /opt/nutboard/scripts/create-readonly-role.sql"      # replace mint with that name
```

The first run creates `nutboard_ro` with a random password and prints a ready-made `DATABASE_URL=...` line; later
runs keep the password and only refresh the grants (re-run after upgrading the mint). It refuses to run in any
database that holds neither Nutshell nor CDK mint tables, so a wrong `-d` cannot grant the wrong tables.

If PostgreSQL runs on another host, run the script there (or over the network with a password-authenticated
superuser), allow the `nutboard_ro` role from this server in `pg_hba.conf` and the firewall, and add
`?sslmode=require` to the URL.

Then the app's secrets, readable by root only (systemd reads the file, not the app):

```sh
cat > /etc/nutboard.env <<'ENV'
DATABASE_URL=postgres://nutboard_ro:THE-PRINTED-PASSWORD@localhost:5432/mint
MINT_TZ=UTC
MINT_NAME=My mint
ENV
chmod 600 /etc/nutboard.env
```

On a **CDK** mint the timestamps are Unix time, so `MINT_TZ` only chooses the zone of the hour-of-day chart and the
rest of this paragraph does not apply.

On a **Nutshell** mint `MINT_TZ` is the time zone the **mint process** writes its timestamps in (Nutshell stores naive local time): `UTC`
for a mint in a container or on a server left on UTC, the host's zone (e.g. `Europe/Prague`) otherwise. A wrong
value shifts everything on the dashboard by the zone offset, so check against the database before guessing:

```sh
su - postgres -c "psql -d mint -c \"SELECT max(created) AS newest_row, now() AT TIME ZONE 'UTC' AS utc_now, now() AT TIME ZONE 'Europe/Prague' AS prague_now FROM promises\""
```

Use the zone whose clock the newest row matches. nutboard also checks this at startup and in the status bar and
says so when the configured zone cannot be right.

**No password at all** (PostgreSQL on the same host): let peer authentication map the `nutboard` service user to
the `nutboard_ro` role and connect over the Unix socket instead of TCP. In `/etc/postgresql/*/main/pg_ident.conf`:

```
# MAPNAME   SYSTEM-USERNAME   PG-USERNAME
nutboard    nutboard          nutboard_ro
```

In `/etc/postgresql/*/main/pg_hba.conf`, above the generic `local all all peer` line (replace `mint`):

```
local   mint   nutboard_ro   peer map=nutboard
```

Then `systemctl reload postgresql` and use the socket in `/etc/nutboard.env`:

```
DATABASE_URL=postgres://nutboard_ro@/mint?host=/var/run/postgresql
```

## 3. The code (Mac, from the repository; the same command updates it later)

```sh
deploy/push.sh root@nutboard.lnpay.cz
```

## 4. The certificate (once)

With the DNS record for `nutboard.lnpay.cz` pointing at the server and nginx running:

```sh
certbot certonly --webroot -w /var/www/html -d nutboard.lnpay.cz   # or: certbot certonly --nginx -d nutboard.lnpay.cz
```

## 5. The service

```sh
cp /opt/nutboard/deploy/nutboard.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now nutboard
systemctl status nutboard
```

## 6. nginx

```sh
cp /opt/nutboard/deploy/nutboard.lnpay.cz.conf /etc/nginx/sites-available/nutboard.lnpay.cz
ln -s /etc/nginx/sites-available/nutboard.lnpay.cz /etc/nginx/sites-enabled/nutboard.lnpay.cz
nginx -t && systemctl reload nginx
```

(nginx installed from nginx.org instead of Debian has no `sites-available`; copy the file to
`/etc/nginx/conf.d/nutboard.lnpay.cz.conf` instead.)

Certbot renews the certificate by itself; to make sure nginx picks the new one up every time (already done if the
invity site set it up):

```sh
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\nsystemctl reload nginx\n' > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
```

## 7. Your passkey

```sh
curl -s https://nutboard.lnpay.cz/api/auth/status; echo   # {"registered":false,...,"rpID":"nutboard.lnpay.cz"}
journalctl -u nutboard -n 30 --no-pager                  # the one-time setup code
```

Open https://nutboard.lnpay.cz on your iPhone or Mac, enter the code and confirm with Face ID / Touch ID.
Setup is closed from then on.

## Day to day

- **Update the code** (Mac): `deploy/push.sh` — copies the code and restarts the service.
- **Logs**: `journalctl -u nutboard -f`; nginx: `/var/log/nginx/nutboard.lnpay.cz.*.log`.
- **Lost every passkey**: reset sign-in, restart, then step 7 again:
  ```sh
  cd /opt/nutboard && runuser -u nutboard -- env AUTH_DB=/var/lib/nutboard/nutboard.db node scripts/auth-reset.ts --yes && systemctl restart nutboard
  ```
- **Firewall**: the app listens on 127.0.0.1 only; port 26545 must not be opened to the outside.
- **The mint was replaced or upgraded** (for example Nutshell to CDK): run the role script in the new database, point
  `DATABASE_URL` at it and restart. The dialect is detected from the tables; passkeys stay.
- **Nothing to back up**: the passkey file can always be recreated with a new setup code; all statistics come from
  the mint database.

## Several mints and LNbits in one dashboard

One nutboard can show several mints and an LNbits instance. Run the role script once in each database (it keeps
the role's password and only adds the grants that database needs), then list the sources in `/etc/nutboard.env`
instead of the single `DATABASE_URL`:

```sh
su - postgres -c "psql -d cashu_mint -f /opt/nutboard/scripts/create-readonly-role.sql"   # Nutshell
su - postgres -c "psql -d cdk_mint   -f /opt/nutboard/scripts/create-readonly-role.sql"   # CDK
su - postgres -c "psql -d lnbits     -f /opt/nutboard/scripts/create-readonly-role.sql"   # LNbits

cat > /etc/nutboard.env <<'ENV'
SITE_NAME=My mints
MINTS=old,cdk
MINT_OLD_DATABASE_URL=postgres://nutboard_ro:THE-PASSWORD@localhost:5432/cashu_mint
MINT_OLD_NAME=Old mint
MINT_OLD_TZ=UTC
MINT_CDK_DATABASE_URL=postgres://nutboard_ro:THE-PASSWORD@localhost:5432/cdk_mint
MINT_CDK_NAME=New mint
LNBITS_DATABASE_URL=postgres://nutboard_ro:THE-PASSWORD@localhost:5432/lnbits
ENV
chmod 600 /etc/nutboard.env
systemctl restart nutboard && journalctl -u nutboard -n 20 --no-pager   # one line per source, each "session read-only: true"
```

nutboard refuses to start when one of the sources cannot be opened read-only, so add a source only once its
database exists. Passkeys stay as they are: the address has not changed.

LNbits on SQLite is not supported; nutboard reads PostgreSQL only.

## The kill switch

Optional. It lets a signed-in operator stop the mints, LNbits, or the tunnel to the Lightning node from the
dashboard. nutboard stays unprivileged: it only drops a request file, and a root-owned helper does the stopping
(see the README for the design). As root:

```sh
# 1. which units belong to which button
install -d -m 755 /etc/nutboard
cp /opt/nutboard/deploy/killswitch/killswitch.conf.example /etc/nutboard/killswitch.conf
$EDITOR /etc/nutboard/killswitch.conf                # unit names as `systemctl list-units` shows them
chmod 644 /etc/nutboard/killswitch.conf

# 2. the root-side helper, outside the directory that deploy/push.sh overwrites
install -m 755 -o root -g root /opt/nutboard/deploy/killswitch/nutboard-kill.sh /usr/local/sbin/nutboard-kill
cp /opt/nutboard/deploy/killswitch/nutboard-kill.path /opt/nutboard/deploy/killswitch/nutboard-kill.service /etc/systemd/system/
cp /opt/nutboard/deploy/killswitch/nutboard-kill.tmpfiles.conf /etc/tmpfiles.d/nutboard-kill.conf
systemd-tmpfiles --create /etc/tmpfiles.d/nutboard-kill.conf      # /run/nutboard-kill, writable by group nutboard
systemctl daemon-reload
systemctl enable --now nutboard-kill.path

# 3. tell nutboard, and give its sandbox the one extra writable path (already in deploy/nutboard.service)
echo 'KILL_SWITCH_DIR=/run/nutboard-kill' >> /etc/nutboard.env
cp /opt/nutboard/deploy/nutboard.service /etc/systemd/system/ && systemctl daemon-reload
systemctl restart nutboard
journalctl -u nutboard -n 20 --no-pager | grep -i "kill switch"   # "requests go to /run/nutboard-kill, units from ... (N units)"
```

The helper is copied to `/usr/local/sbin` on purpose: a later `deploy/push.sh` updates the dashboard but never
the code that runs as root. Re-install it by hand after reading the diff when it changes.

**A dry run that cannot touch a real service**: run the helper by hand against a scratch directory and a list
that names a unit which does not exist.

```sh
mkdir -p /tmp/kill-test && printf 'MINT_UNITS="does-not-exist.service"\n' > /tmp/kill-test.conf
touch /tmp/kill-test/mints.request
NUTBOARD_KILL_DIR=/tmp/kill-test NUTBOARD_KILL_CONF=/tmp/kill-test.conf /usr/local/sbin/nutboard-kill
ls /tmp/kill-test        # empty: the request was consumed
```

It prints `request: link=0 mints=1 lnbits=0` and `FAILED to stop does-not-exist.service`. Do **not** create files
in `/run/nutboard-kill` to try things out: that is the real switch, and `mints.request` there stops the mints.

**What a pull does.** `systemctl disable --now` for every unit of the chosen group; for "Cut the link" the
tunnel goes first, then the mints and LNbits. The units stay down across reboots. In the dashboard a pull needs
the phrase typed in and Face ID / Touch ID, and it is logged with the passkey that confirmed it.

**Starting again** is deliberately not possible from the dashboard:

```sh
systemctl enable --now wg-quick@wg0      # the tunnel first, if it was cut
systemctl enable --now cashu-mint cdk-mintd lnbits
```

**What it is not.** If this server itself is compromised, whoever has root can bring the tunnel back. The switch
that holds in that case is on the Lightning node: remove this server's WireGuard peer there.

## Separate dashboards instead of one

If the mints should not share an address or passkeys, run one nutboard per mint from the same code with the
systemd template instead of listing them in `MINTS`. Each instance has its own
address, port, environment file and passkeys; `nutboard.service` from step 5 stays as it is.

```sh
# grants for the shared read-only role in the other mint database (keeps the role's password)
su - postgres -c "psql -d cdk_mint -f /opt/nutboard/scripts/create-readonly-role.sql"

install -d -m 700 /etc/nutboard
cat > /etc/nutboard/cdk.env <<'ENV'
DATABASE_URL=postgres://nutboard_ro:THE-SAME-PASSWORD@localhost:5432/cdk_mint
ORIGIN=https://nutboard-cdk.example.com
PORT=26546
MINT_NAME=My CDK mint
ENV
chmod 600 /etc/nutboard/cdk.env

cp "/opt/nutboard/deploy/nutboard@.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now nutboard@cdk
journalctl -u nutboard@cdk -n 30 --no-pager      # mint: cdk, and the one-time setup code
```

Then repeat steps 4 and 6 for the new host name (a copy of `nutboard.lnpay.cz.conf` with the other `server_name`,
certificate paths and port) and step 7 for a passkey: passkeys belong to the address they were created on, so the
second dashboard needs its own. `deploy/push.sh` restarts every `nutboard@` instance along with the main service.
