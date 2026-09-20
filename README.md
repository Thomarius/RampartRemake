# Rampart Remake

A multiplayer recreation of the 1990 Atari arcade game _Rampart_: shoot down your
opponents' castle walls, then race to rebuild your own with falling blocks before the
next barrage. Fail to seal a castle and you are out. Last player standing wins.

- Online play via shareable room codes, 2–4 players, AI filling any empty slot
- Interchangeable visual styles: a minimal flat look, and procedural art generated at runtime — no binary art in the repository
- Authoritative server; the simulation is deterministic and shared by client, server and bots

See [`docs/PLAN.md`](docs/PLAN.md) for the design and what is still open, and
[`docs/ARCHIVE.md`](docs/ARCHIVE.md) for how each decision was reached — with the
measurements behind it, and the attempts that were reverted.

## Requirements

Node.js >= 22.12 (see `.nvmrc`). npm 11+.

## Getting started

```bash
npm install
npm run check          # format, lint, typecheck, test
```

The game is playable offline against bots, online through the bundled server, and in
either of two visual styles:

```bash
# Run bot-vs-bot matches with no renderer, and print outcomes and state hashes
npm start -w @rampart/headless -- --matches 20 --players 3 --difficulty marshal

# Print a generated map as ASCII
npm start -w @rampart/headless -- --map --players 4 --seed 11

npm run build -w @rampart/client   # the server serves the built client
npm start   -w @rampart/server     # play online at http://localhost:8080
npm run dev -w @rampart/client     # play a local match at http://localhost:5173
```

The client takes dev query parameters: `?autostart=1&players=4&seed=3` skips the menu,
`&snapshot=build` jumps straight to a given phase, `&speed=10` runs the clock faster,
`&style=flat` picks a visual style, and `&watch=1&bots=marshal` fills every seat with a
bot so a match can be observed rather than played. All are available from the menu too.

## Deployment

One image, one process: it serves the built client over HTTP and runs the authoritative
match loop over the same port's WebSocket.

```bash
docker build -t rampart .
docker run -p 8080:8080 rampart          # http://localhost:8080
docker run -e PORT=3000 -p 3000:3000 rampart
```

`PORT` and `HOST` are the only settings the environment may change, because they are the
only ones that are not game rules — a rule an environment variable could alter is a rule
two clients could disagree about, which is a desync rather than a setting. Everything else
comes from `config/*.json` and is baked into the image. Hosts that assign a port (Fly,
Railway) set `PORT` themselves and need no further configuration.

The runtime image carries three directories and no `node_modules`: the config files, the
built client, and a single bundled `main.js` holding the server, simulation, AI and
protocol. Development is unaffected — internal packages still export TypeScript source
with no build step between them, and `npm start -w @rampart/server` still runs it directly
through tsx. The bundle exists only for the image.

## Layout

| Path                | Contents                                             |
| ------------------- | ---------------------------------------------------- |
| `config/`           | Every tunable in the game, as JSON                   |
| `packages/config`   | Schemas, typed defaults, cross-file validation       |
| `packages/sim`      | Deterministic game core — no DOM, no Node, no I/O    |
| `packages/protocol` | Wire message types and validators                    |
| `packages/ai`       | Bot logic                                            |
| `packages/server`   | Authoritative match server                           |
| `packages/client`   | Renderer, UI, procedural asset generators            |
| `tools/headless`    | Bot-vs-bot harness for balance tuning and soak tests |
| `assets/audio`      | User-supplied audio (missing files are silent)       |

## Configuration

No game rule is hardcoded. Phase timings, cannon rewards, crater shape, enclosure rules,
map generation, palettes and sprite parameters all live in `config/*.json`, validated by
strict schemas — an unknown key is an error rather than a silently ignored one. The server
sends the ruleset to clients in the match snapshot, so both sides always run one identical
copy.

## Status

| Milestone                                | State                    |
| ---------------------------------------- | ------------------------ |
| M0 — scaffold, config schemas, CI        | Done                     |
| M1 — simulation core                     | Done                     |
| M2 — locally playable, placeholder art   | Done                     |
| M3 — procedural art                      | Done                     |
| M4 — online multiplayer                  | Done                     |
| M5 — AI opponents                        | Done                     |
| M6 — full scope, 2–8 players, deployment | Done but for audio files |
| M7 — balance pass                        | In progress              |

## License

MIT
