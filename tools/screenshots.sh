#!/usr/bin/env bash
# Screenshots of the client in fixed states, for checking layout by eye.
#
# Headless Chrome cannot verify anything that depends on the clock (CLAUDE.md), but it
# renders in real time well enough to be *looked at*: ?autostart with &snapshot jumps to a
# phase, &round=N to a phase deep in a match, and waiting lets the clock carry a state
# into the moment worth seeing — an announcement is on screen for four seconds, about
# twenty after a build phase opens.
#
#   npm run dev -w @rampart/client            # in another terminal, or BASE=...
#   tools/screenshots.sh [outdir] [scene...]  # all scenes by default
#
# Uses the latest Playwright through npx, whose browser matches the one cached here.
set -euo pipefail

OUT=${1:-/tmp/shots}
shift || true
BASE=${BASE:-http://localhost:5173}
GAME="$BASE/?autostart=1&players=3&seed=7"
# Bots in every seat, so the cannon phase ends early and the banners come on time.
WATCH="$GAME&watch=1&bots=gunner"

# name|query appended to the base|milliseconds to wait
SCENES=(
  "menu|$BASE/|1500"
  "build-flat|$GAME&snapshot=build&style=flat|2000"
  "build-pixel|$GAME&snapshot=build&style=pixel|2000"
  "cannons-pixel|$GAME&snapshot=cannon_place&round=2&style=pixel|2000"
  "standings|$GAME&snapshot=build&round=2&style=flat|25500"
  "final-round|$GAME&snapshot=cannon_place&round=9&style=flat|27500"
  "game-over|$GAME&snapshot=game_over&style=flat|2000"
  "game-over-watched|$GAME&snapshot=game_over&watch=1&style=pixel|2000"
  "combat-close|$BASE/?autostart=1&players=2&seed=5&snapshot=combat&round=3&style=pixel|4200"
  "gains|$GAME&snapshot=build&round=3&style=pixel|21800"
  "life-lost|$GAME&snapshot=build&round=2&style=pixel|21600"
  "knocked-out|$GAME&snapshot=combat&round=5&idle=1&style=pixel|2500"
  # The banners, mid-crossing, in the default looks (&style= sets both looks to one).
  # Waits are real time, so a slower machine may need them nudged.
  "wipe-to-build|$WATCH&snapshot=combat&round=2|20000"
  "sweep|$WATCH&snapshot=build&round=2|24500"
  "wipe-to-combat|$WATCH&snapshot=build&round=2|30500"
  # The clock has run out; the border pulses, so it may be caught faint.
  "overtime|$GAME&snapshot=build&round=2|21500"
  "four-players|$BASE/?autostart=1&players=4&seed=3&snapshot=combat&round=3&style=pixel|3000"
)

mkdir -p "$OUT"
for scene in "${SCENES[@]}"; do
  IFS='|' read -r name url wait <<<"$scene"
  if [[ $# -gt 0 && ! " $* " =~ " $name " ]]; then continue; fi
  (cd /tmp && npx -y playwright@latest screenshot --viewport-size "1400,900" \
    --wait-for-timeout "$wait" "$url" "$OUT/$name.png" >/dev/null 2>&1 &&
    echo "$OUT/$name.png") &
done
wait
