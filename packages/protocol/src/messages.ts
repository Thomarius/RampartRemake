import { DifficultySchema, MatchSettingsSchema, SettingBoundsSchema } from '@rampart/config';
import { z } from 'zod';

import { SnapshotSchema } from './snapshot.js';

/** Bumped on any breaking change to the message set; mismatched clients are rejected. */
export const PROTOCOL_VERSION = 8;

/**
 * A player's intent. The server overwrites `player` with the sender's own seat before
 * doing anything with it, so a client cannot act on another's behalf.
 */
export const ActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('select_castle'),
    player: z.number().int().nonnegative(),
    castleId: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal('fire'),
    player: z.number().int().nonnegative(),
    x: z.number().int(),
    y: z.number().int(),
  }),
  z.strictObject({
    kind: z.literal('place_piece'),
    player: z.number().int().nonnegative(),
    x: z.number().int(),
    y: z.number().int(),
    rotation: z.number().int(),
  }),
  z.strictObject({
    kind: z.literal('place_cannon'),
    player: z.number().int().nonnegative(),
    x: z.number().int(),
    y: z.number().int(),
  }),
]);

export const SeatSchema = z.strictObject({
  playerId: z.number().int().nonnegative(),
  name: z.string(),
  isBot: z.boolean(),
  connected: z.boolean(),
  ready: z.boolean(),
});
export type Seat = z.infer<typeof SeatSchema>;

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('create'),
    protocol: z.number().int(),
    name: z.string().min(1).max(24),
    players: z.number().int().min(2).max(8),
  }),
  z.strictObject({
    type: z.literal('join'),
    protocol: z.number().int(),
    name: z.string().min(1).max(24),
    code: z.string().min(4).max(12),
    /** Presenting a token reclaims a seat instead of taking a new one. */
    token: z.string().optional(),
  }),
  z.strictObject({ type: z.literal('ready'), ready: z.boolean() }),
  /**
   * Host only, before the match starts: the skill of the bots filling the empty
   * seats, indexed by seat, and any match settings to change. Entries for seats a
   * person holds are ignored, and so is a setting outside the server's bounds.
   */
  z.strictObject({
    type: z.literal('configure'),
    bots: z.array(DifficultySchema).optional(),
    settings: MatchSettingsSchema.partial().optional(),
    /** Seats at the table; refused unless the team size allows it and everyone fits. */
    playerCount: z.number().int().min(2).max(8).optional(),
    /** Each seat's team, by seat; taken only if it makes equal teams. */
    teams: z.array(z.number().int().nonnegative()).max(8).optional(),
    /** The map: every island, castle and seat's island follow from it. */
    seed: z.number().int().nonnegative().max(0xffffffff).optional(),
    /** A bot to play the host's own seat, or null for the host to play it. */
    hostBot: DifficultySchema.nullable().optional(),
    /**
     * Moves the person in seat `from` to seat `to`, swapping places with whoever is
     * there — another person, or a bot, which keeps its skill. Teams belong to seats, so
     * this is how the host puts people on the same team or on opposing ones.
     */
    move: z
      .strictObject({
        from: z.number().int().nonnegative().max(7),
        to: z.number().int().nonnegative().max(7),
      })
      .optional(),
  }),
  z.strictObject({ type: z.literal('start') }),
  z.strictObject({ type: z.literal('action'), action: ActionSchema }),
  z.strictObject({ type: z.literal('ping'), t: z.number() }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('welcome'),
    protocol: z.number().int(),
    code: z.string(),
    playerId: z.number().int().nonnegative(),
    /** Presented on reconnect to reclaim this seat. */
    token: z.string(),
    hostId: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal('room'),
    code: z.string(),
    seats: z.array(SeatSchema),
    /** Total seats at the table; any beyond the joined players are filled by bots. */
    playerCount: z.number().int().min(2).max(8),
    /** Skill of the bot in each seat, so everyone can see what they are about to face. */
    bots: z.array(DifficultySchema),
    /** The match settings as they stand, and what the host may set them to. */
    settings: MatchSettingsSchema,
    settingBounds: SettingBoundsSchema,
    /** Each seat's team, by seat. */
    teams: z.array(z.number().int().nonnegative()),
    /**
     * The match seed, drawn when the room is created rather than at the start, so the
     * lobby can show the map that will be played — and which island each seat gets.
     */
    seed: z.number().int().nonnegative(),
    /** The bot playing the host's seat while the host watches, or null. */
    hostBot: DifficultySchema.nullable(),
    /** The player counts the rules allow at all, before the team size narrows them. */
    playerLimits: z.strictObject({ min: z.number().int(), max: z.number().int() }),
    hostId: z.number().int().nonnegative(),
    started: z.boolean(),
  }),
  z.strictObject({ type: z.literal('snapshot'), snapshot: SnapshotSchema }),
  /**
   * The actions applied at one tick, after which the tick was stepped. Receiving
   * commit T means the client may safely advance its own simulation to T + 1: the
   * server never assigns an action to a tick it has already stepped past.
   */
  z.strictObject({
    type: z.literal('commit'),
    tick: z.number().int().nonnegative(),
    actions: z.array(ActionSchema),
    /** Periodic state fingerprint; a mismatch means the client has desynced. */
    hash: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal('rejected'),
    action: ActionSchema,
    reason: z.string(),
  }),
  z.strictObject({
    type: z.literal('pong'),
    t: z.number(),
    serverTick: z.number().int().nonnegative(),
  }),
  z.strictObject({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

export function encode(message: ServerMessage | ClientMessage): string {
  return JSON.stringify(message);
}

/** Parses an untrusted frame. Returns null rather than throwing on anything malformed. */
export function decodeClientMessage(raw: string): ClientMessage | null {
  try {
    const parsed = ClientMessageSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function decodeServerMessage(raw: string): ServerMessage | null {
  try {
    const parsed = ServerMessageSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
