import { RulesetSchema, TerrainConfigSchema } from '@rampart/config';
import { PHASES, type MatchState } from '@rampart/sim';
import { z } from 'zod';

/**
 * Run-length encoding for the grid layers.
 *
 * A snapshot's dynamic layers are mostly long runs of nothing, so this is both far
 * smaller than the raw array and trivially cheap. Terrain and island membership are
 * never sent at all: they are regenerated from the seed, which the determinism work
 * makes safe.
 */
export function encodeRle(data: Uint8Array): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const value = data[i] as number;
    let run = 1;
    while (i + run < data.length && data[i + run] === value) run++;
    out.push(value, run);
    i += run;
  }
  return out;
}

export function decodeRle(rle: readonly number[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let at = 0;
  for (let i = 0; i + 1 < rle.length; i += 2) {
    const value = rle[i] as number;
    const run = rle[i + 1] as number;
    for (let k = 0; k < run && at < length; k++) out[at++] = value;
  }
  return out;
}

const PlayerSchema = z.strictObject({
  id: z.number().int().nonnegative(),
  islandId: z.number().int().positive(),
  name: z.string(),
  isBot: z.boolean(),
  eliminated: z.boolean(),
  eliminatedRound: z.number().int().nullable(),
  startingCastleId: z.number().int().nullable(),
  enclosedCastles: z.number().int().nonnegative(),
  cannonsToPlace: z.number().int().nonnegative(),
  pieceIndex: z.number().int().nonnegative(),
  continuesRemaining: z.number().int().nonnegative(),
  pieceRound: z.number().int().nonnegative(),
  score: z.number().int().nonnegative(),
  wallsDestroyed: z.number().int().nonnegative(),
});

const CastleSchema = z.strictObject({
  id: z.number().int().nonnegative(),
  islandId: z.number().int().positive(),
  x: z.number().int(),
  y: z.number().int(),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
  enclosed: z.boolean(),
});

const CannonSchema = z.strictObject({
  id: z.number().int().nonnegative(),
  owner: z.number().int().nonnegative(),
  x: z.number().int(),
  y: z.number().int(),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
  active: z.boolean(),
  shotId: z.number().int().nullable(),
});

const ShotSchema = z.strictObject({
  id: z.number().int().nonnegative(),
  cannonId: z.number().int().nonnegative(),
  owner: z.number().int().nonnegative(),
  fromX: z.number(),
  fromY: z.number(),
  toX: z.number().int(),
  toY: z.number().int(),
  launchTick: z.number().int(),
  impactTick: z.number().int(),
});

/**
 * Everything a client needs to reconstruct the match exactly.
 *
 * The ruleset travels with it, so a client can never be running different rules from
 * the server — a mismatch would desync the simulation rather than merely look wrong.
 */
export const SnapshotSchema = z.strictObject({
  seed: z.number().int(),
  ruleset: RulesetSchema,
  terrain: TerrainConfigSchema,
  tick: z.number().int().nonnegative(),
  round: z.number().int().nonnegative(),
  phase: z.enum(PHASES),
  pendingPhase: z.enum(PHASES).nullable(),
  phaseEndTick: z.number().int(),
  players: z.array(PlayerSchema).min(2),
  structure: z.array(z.number().int().nonnegative()),
  owner: z.array(z.number().int().nonnegative()),
  territory: z.array(z.number().int().nonnegative()),
  castles: z.array(CastleSchema),
  cannons: z.array(CannonSchema),
  shots: z.array(ShotSchema),
  nextCannonId: z.number().int().nonnegative(),
  nextShotId: z.number().int().nonnegative(),
  winners: z.array(z.number().int().nonnegative()),
  draw: z.boolean(),
  endedBy: z.enum(['elimination', 'round_cap']).nullable(),
});

export type Snapshot = z.infer<typeof SnapshotSchema>;

export function captureSnapshot(state: MatchState): Snapshot {
  return {
    seed: state.seed,
    ruleset: state.ruleset,
    terrain: state.terrainConfig,
    tick: state.tick,
    round: state.round,
    phase: state.phase,
    pendingPhase: state.pendingPhase,
    phaseEndTick: state.phaseEndTick,
    players: state.players.map((p) => ({ ...p })),
    structure: encodeRle(state.structure),
    owner: encodeRle(state.owner),
    territory: encodeRle(state.territory),
    castles: state.castles.map((c) => ({ ...c })),
    cannons: state.cannons.map((c) => ({ ...c })),
    shots: state.shots.map((s) => ({ ...s })),
    nextCannonId: state.nextCannonId,
    nextShotId: state.nextShotId,
    winners: [...state.winners],
    draw: state.draw,
    endedBy: state.endedBy,
  };
}

/**
 * Overwrites a freshly created match with a snapshot.
 *
 * The caller builds the base state with `createMatch` using the snapshot's seed and
 * ruleset, which regenerates the terrain and the piece sequence; only what cannot be
 * derived is carried over the wire.
 */
export function applySnapshot(state: MatchState, snapshot: Snapshot): void {
  const size = state.width * state.height;
  state.tick = snapshot.tick;
  state.round = snapshot.round;
  state.phase = snapshot.phase;
  state.pendingPhase = snapshot.pendingPhase;
  state.phaseEndTick = snapshot.phaseEndTick;
  state.players = snapshot.players.map((p) => ({ ...p }));
  state.structure = decodeRle(snapshot.structure, size);
  state.owner = decodeRle(snapshot.owner, size);
  state.territory = decodeRle(snapshot.territory, size);
  state.castles = snapshot.castles.map((c) => ({ ...c }));
  state.cannons = snapshot.cannons.map((c) => ({ ...c }));
  state.shots = snapshot.shots.map((s) => ({ ...s }));
  state.nextCannonId = snapshot.nextCannonId;
  state.nextShotId = snapshot.nextShotId;
  state.winners = [...snapshot.winners];
  state.draw = snapshot.draw;
  state.endedBy = snapshot.endedBy;
  state.events = [];
}
