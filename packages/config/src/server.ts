import { z } from 'zod';

export const ServerConfigSchema = z.strictObject({
  port: z.number().int().min(1).max(65535),
  host: z.string().min(1),

  rooms: z.strictObject({
    codeLength: z.number().int().min(4).max(12),
    /** Ambiguous glyphs (0/O, 1/I) are excluded so codes can be read aloud. */
    codeAlphabet: z.string().min(16),
    maxConcurrent: z.number().int().positive(),
    emptyRoomTtlMs: z.number().int().positive(),
    abandonedMatchTtlMs: z.number().int().positive(),
  }),

  limits: z.strictObject({
    maxMessagesPerSecond: z.number().int().positive(),
    maxMessageBytes: z.number().int().positive(),
    maxNameLength: z.number().int().positive(),
  }),

  reconnect: z.strictObject({
    graceMs: z.number().int().nonnegative(),
    botTakeoverDelayMs: z.number().int().nonnegative(),
  }),

  /** Skill of the bots that fill empty seats and cover dropped players. */
  botDifficulty: z.enum(['recruit', 'gunner', 'marshal']),

  snapshot: z.strictObject({
    onPhaseChange: z.boolean(),
    keepaliveIntervalMs: z.number().int().positive(),
  }),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;
