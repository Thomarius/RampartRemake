import { z } from 'zod';

/**
 * Canonical cue list. The manifest must cover exactly these — adding a cue here
 * without adding it to audio.manifest.json (or vice versa) is a startup error,
 * so code and manifest cannot drift apart.
 */
export const SFX_CUES = [
  /** Committing a choice: a castle at the start, a cannon onto sealed ground. */
  'select',
  'cannon_fire',
  'shot_impact',
  /** The shot hit wall rather than open ground — the shooter's fire is working. */
  'wall_destroyed',
  /** Spoken. Opens the combat phase. */
  'voice_fire',
  /** Spoken. Closes it: no further shots can be started. */
  'voice_cease_fire',
  /** Fanfare: a wall closed this round that took in a castle the player did not hold. */
  'enclosure_success',
  /** Its counterpart: ground held last round that is no longer sealed. */
  'enclosure_failed',
  'player_eliminated',
  'piece_place',
  'piece_rotate',
  'piece_invalid',
  'countdown_tick',
] as const;
export type SfxCue = (typeof SFX_CUES)[number];

/**
 * One track per mood rather than per phase. Castle select, cannon placement and
 * building are all the same thing from the player's side — laying out a position with
 * nothing incoming — so they share a track, and only the barrage gets its own.
 */
export const MUSIC_CUES = [
  'music_menu',
  'music_admin',
  'music_battle',
  'music_victory',
  'music_defeat',
] as const;
export type MusicCue = (typeof MUSIC_CUES)[number];

const SfxEntrySchema = z.strictObject({
  file: z.string().min(1),
  volume: z.number().min(0).max(1),
  /** Numbered alternates chosen at random, to avoid repetition fatigue. */
  variants: z.number().int().positive().optional(),
});

const MusicEntrySchema = z.strictObject({
  file: z.string().min(1),
  volume: z.number().min(0).max(1),
  loop: z.boolean(),
});

export const AudioManifestSchema = z.strictObject({
  basePath: z.string().min(1),
  masterVolume: z.number().min(0).max(1),
  /** The game must be fully playable before a single audio file exists. */
  missingFilesAreSilent: z.boolean(),
  sfx: z.record(z.enum(SFX_CUES), SfxEntrySchema),
  music: z.record(z.enum(MUSIC_CUES), MusicEntrySchema),
});

export type AudioManifest = z.infer<typeof AudioManifestSchema>;
