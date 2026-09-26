# Rampart Remake

A multiplayer recreation of the 1990 Atari arcade game _Rampart_: shoot down your
opponents' castle walls, then race to rebuild your own with falling blocks before the
next barrage. Fail to seal a castle and you lose a life; run out of lives and you are
out. After ten rounds, the best score among those still standing wins.

- 2–8 players, free-for-all or in equal teams; bots fill any empty seat
- Play alone on your own computer, with friends on your home network, or over the internet
- Two visual styles — procedural pixel art generated at runtime, and a minimal flat look
- An authoritative server, with a deterministic simulation shared by client, server and bots

---

## Play it in three steps

You need **Node.js 22.12 or newer** (24 recommended). Get it from
[nodejs.org](https://nodejs.org) — the "LTS" download is fine. Then, in a terminal, in
this folder:

```bash
npm install     # once: fetches everything the game needs
npm start       # builds the game and starts it
```

When it says `rampart server on http://0.0.0.0:8080`, open **http://localhost:8080** in
your browser. Leave the terminal open while you play; `Ctrl+C` stops the game.

Enter a name, press **Play**, set up the table — how many players, teams, bot skill,
rounds — and press **Start match**. If nobody else joins, the match runs on your own
computer against bots.

---

## Play with others

The computer that ran `npm start` is the **host**. Everyone else only needs a browser.

### On the same network (LAN, Wi-Fi at home)

1. **Find the host's address on the network.**
   - Windows: open a terminal, run `ipconfig`, and look for **IPv4 Address**, e.g.
     `192.168.1.23`.
   - macOS: _System Settings → Network → Wi-Fi (or Ethernet) → Details_, the **IP address**.
   - Linux: run `hostname -I` and take the first address.
2. **Let the game through the host's firewall**, on **port 8080**, TCP.
   - Windows asks the first time the game starts — choose **Allow**, at least for private
     networks.
   - macOS may ask likewise — choose **Allow**.
   - Linux with ufw: `sudo ufw allow 8080/tcp`.
3. **The host presses Play.** The lobby shows a **room code**, e.g. `AX8ZLU`.
4. **Everyone else** opens **`http://192.168.1.23:8080`** — the host's address from step 1,
   then `:8080` — types their name, enters the room code and presses **Join**. Or the host
   can send them a direct link: `http://192.168.1.23:8080/?join=AX8ZLU&name=Bo` — the
   `&name=` part sets their name, and without it they join as "Player".
5. The host sets up the table and presses **Start match**.

Use `http://`, not `https://`. The address has to be the host's network address —
`localhost` only ever means "this computer".

### Over the internet

Everything on the LAN applies; in addition, people outside your network need a way in.

1. **Forward port 8080 on your router to the host.** In the router's settings (usually
   at `http://192.168.1.1` or `http://192.168.0.1`; look for _Port forwarding_,
   _Virtual server_ or _NAT_), add a rule:
   - external port **8080**, protocol **TCP**
   - to internal IP **the host's LAN address** (step 1 above), internal port **8080**

   That single port carries everything — the web page and the live game connection.
   Nothing else needs opening.

2. **Find your public address**, for instance at [whatismyip.com](https://whatismyip.com),
   e.g. `203.0.113.7`.
3. **Friends open `http://203.0.113.7:8080`** and join with the room code, as above.

Good to know:

- **Your public address can change** when the router reconnects; check it again before
  a session. A dynamic DNS name (many routers offer one) avoids this.
- **Some internet connections cannot take incoming connections at all** ("CGNAT", common
  on mobile and some fibre and cable providers): the forward is set up correctly and still
  nobody gets in. Then use a VPN that puts everyone on one network — for example
  [Tailscale](https://tailscale.com) or ZeroTier — and play as on a LAN with the host's VPN
  address; or run the game on a server with a public address, as below.
- **To test the forward, use a phone on mobile data**, not a device on your own Wi-Fi —
  many routers do not loop connections back to their own public address.
- To use another port, start with `PORT=3000 npm start` (on Windows PowerShell:
  `$env:PORT=3000; npm start`) and forward that port instead.

### On a server, with Docker

One image, one process: it serves the game over HTTP and runs the matches over the same
port.

```bash
docker build -t rampart .
docker run -p 8080:8080 rampart          # http://<server address>:8080
docker run -e PORT=3000 -p 3000:3000 rampart
```

Hosts that assign a port themselves (Fly, Railway) set `PORT` and need nothing else. If
the game is served through `https://`, it connects over secure WebSockets automatically.
`PORT` and `HOST` are the only settings the environment may change: everything else is a
game rule, and a rule an environment variable could alter is a rule two players could
disagree about — which is a desync, not a setting. The runtime image carries no
`node_modules`: the config files, the built client, and one bundled `main.js`.

---

## Development

```bash
npm install
npm run check                       # format, lint, typecheck, test — takes a few minutes
npm run dev   -w @rampart/client    # play offline with live reload at http://localhost:5173
npm start     -w @rampart/server    # the server alone, serving the last build
npm start     -w @rampart/headless -- --matches 8 --players 3 --difficulty gunner --stats out.csv
npm start     -w @rampart/headless -- --map --players 3 --seed 2   # print a map as ASCII
tools/screenshots.sh /tmp/shots     # the client in fixed states, against the dev server
```

The dev server has no game server behind it, so its lobby is always a local table.
The client takes query parameters for development: `?autostart=1&players=4&seed=3` skips
the menu, `&snapshot=build&round=3` jumps to a phase, `&teams=2` seats teams of two,
`&watch=1&bots=marshal` fills every seat with bots, `&style=flat` picks a style, and
`&speed=10` runs the clock faster.

See [`docs/PLAN.md`](docs/PLAN.md) for the design and what is still open, and
[`docs/ARCHIVE.md`](docs/ARCHIVE.md) for how each decision was reached — with the
measurements behind it, and the attempts that were reverted. `CLAUDE.md` is the short
orientation.

## Layout

| Path                | Contents                                             |
| ------------------- | ---------------------------------------------------- |
| `config/`           | Every tunable in the game, as JSON                   |
| `packages/config`   | Schemas, typed defaults, cross-file validation       |
| `packages/sim`      | Deterministic game core — no DOM, no Node, no I/O    |
| `packages/protocol` | Wire message types and validators                    |
| `packages/ai`       | Bot logic                                            |
| `packages/server`   | Authoritative match server                           |
| `packages/client`   | Renderer, UI, lobby, procedural asset generators     |
| `tools/headless`    | Bot-vs-bot harness for balance tuning and soak tests |
| `assets/audio`      | Audio cues (missing files are silent)                |

## Configuration

No game rule is hardcoded. Phase timings, cannon rewards, scoring, teams, map generation,
palettes and sprite parameters all live in `config/*.json`, validated by strict schemas —
an unknown key is an error rather than a silently ignored one. The server sends the
ruleset to every client in the match snapshot, so all of them run one identical copy.

## Status

| Milestone                                    | State                    |
| -------------------------------------------- | ------------------------ |
| M0 — scaffold, config schemas, CI            | Done                     |
| M1 — simulation core                         | Done                     |
| M2 — locally playable, placeholder art       | Done                     |
| M3 — procedural art                          | Done                     |
| M4 — online multiplayer                      | Done                     |
| M5 — AI opponents                            | Done                     |
| M6 — full scope, 2–8 players, deployment     | Done but for audio files |
| M7 — balance pass                            | In progress              |
| M8 — team mode, one lobby online and offline | Done                     |

## License

MIT
