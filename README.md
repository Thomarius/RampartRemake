# Rampart Remake

A multiplayer recreation of the 1990 Atari arcade game _Rampart_: shoot down your
opponents' castle walls, then race to rebuild your own with falling blocks before the
next barrage. Fail to seal a castle and you are out. Last player standing wins.

- Online play via shareable room codes, 2–4 players, AI filling any empty slot
- Interchangeable visual styles: a minimal flat look, and procedural art generated at runtime — no binary art in the repository
- Authoritative server; the simulation is deterministic and shared by client, server and bots

See [`docs/PLAN.md`](docs/PLAN.md) for the full design and implementation plan.

## Requirements

Node.js >= 22.12 (see `.nvmrc`). npm 11+.

## Getting started

```bash
npm install
npm run check          # format, lint, typecheck, test
```

The game is playable locally against stopgap opponents; there is no network or art yet:

```bash
# Run bot-vs-bot matches with no renderer, and print outcomes and state hashes
npm start -w @rampart/headless -- --matches 20 --players 3

# Print a generated map as ASCII
npm start -w @rampart/headless -- --map --players 4 --seed 11

npm start   -w @rampart/server     # load and cross-validate config from disk
npm run dev -w @rampart/client     # play a local match at http://localhost:5173
```

The client takes dev query parameters: `?autostart=1&players=4&seed=3` skips the menu,
`&snapshot=build` jumps straight to a given phase, `&speed=10` runs the clock faster, and
`&style=flat` picks a visual style (also available from the menu).

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

| Milestone                              | State |
| -------------------------------------- | ----- |
| M0 — scaffold, config schemas, CI      | Done  |
| M1 — simulation core                   | Next  |
| M2 — locally playable, placeholder art |       |
| M3 — procedural art                    |       |
| M4 — online multiplayer                |       |
| M5 — AI opponents                      |       |
| M6 — full scope, audio, deployment     |       |
| M7 — balance pass                      |       |

## License

MIT
