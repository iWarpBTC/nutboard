#!/bin/sh
# Root-side half of nutboard's kill switch. Install as /usr/local/sbin/nutboard-kill (see deploy/README.md).
#
# nutboard cannot stop anything itself. It drops an empty file with one of four fixed names into
# /run/nutboard-kill; nutboard-kill.path sees it and starts this script as root. The script looks only at
# WHICH names exist, never at what a file contains, stops and disables the units listed in
# /etc/nutboard/killswitch.conf, and removes the requests.
#
#   mints.request     stop the mints
#   lnbits.request    stop LNbits
#   all.request       both
#   lnd-link.request  take the tunnel to the Lightning node down first, then both
#
# It only ever stops things. Starting them again is done by hand:
#   systemctl enable --now <unit>
set -u

DIR=${NUTBOARD_KILL_DIR:-/run/nutboard-kill}
CONF=${NUTBOARD_KILL_CONF:-/etc/nutboard/killswitch.conf}
MINT_UNITS=
LNBITS_UNITS=
LND_LINK_UNITS=
# shellcheck disable=SC1090
[ -r "$CONF" ] && . "$CONF"

log() {
  logger -t nutboard-kill -p auth.crit -- "$*" 2>/dev/null || true
  echo "nutboard-kill: $*"
}

stop_units() {
  for unit in $1; do
    case "$unit" in
      '' | *[!A-Za-z0-9@:._-]*)
        log "skipping a unit name with unexpected characters"
        continue
        ;;
    esac
    if systemctl disable --now -- "$unit"; then
      log "stopped and disabled $unit"
    else
      log "FAILED to stop $unit"
    fi
  done
}

want_mints=0
want_lnbits=0
want_link=0
[ -e "$DIR/mints.request" ] && want_mints=1
[ -e "$DIR/lnbits.request" ] && want_lnbits=1
[ -e "$DIR/all.request" ] && want_mints=1 && want_lnbits=1
[ -e "$DIR/lnd-link.request" ] && want_link=1 && want_mints=1 && want_lnbits=1

if [ "$want_link$want_mints$want_lnbits" = 000 ]; then
  log "started without a known request in $DIR"
else
  log "request: link=$want_link mints=$want_mints lnbits=$want_lnbits"
fi

# The link first: it is what keeps money from leaving.
[ "$want_link" = 1 ] && stop_units "$LND_LINK_UNITS"
[ "$want_mints" = 1 ] && stop_units "$MINT_UNITS"
[ "$want_lnbits" = 1 ] && stop_units "$LNBITS_UNITS"

# Clear every request, known or not, so the path unit does not fire again for the same files.
find "$DIR" -mindepth 1 -maxdepth 1 -name '*.request' -exec rm -f -- {} + 2>/dev/null
exit 0
