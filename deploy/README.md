# Deploying to nutboard.lnpay.cz (Debian VPS with nginx)

```
browser ──HTTPS──▶ nginx (nutboard.lnpay.cz, Let's Encrypt) ──▶ node src/server.ts on 127.0.0.1:26545 (user nutboard)
                                                                  ├─ PostgreSQL: the Nutshell mint database (read-only role)
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
runs keep the password and only refresh the grants (re-run after upgrading Nutshell). It refuses to run in any
database without a `keysets` table, so a wrong `-d` cannot grant the wrong tables.

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

`MINT_TZ` is the time zone the **mint process** writes its timestamps in (Nutshell stores naive local time): `UTC`
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
- **Nothing to back up**: the passkey file can always be recreated with a new setup code; all statistics come from
  the mint database.
