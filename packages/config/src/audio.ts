import { z } from 'zod';

/**
 * Canonical cue list. The manifest must cover exactly these — adding a cue here
 * without adding it to audio.manifest.json (or vice versa) is a startup error,
 * so code and manifest cannot drift apart.
 */
export const SFX_CUES = [
  'cannon_fire',
  'shot_impact',
  'wall_destroyed',
  'piece_rotate',
  'piece_place',
  'piece_invalid',
  'cannon_place',
  'phase_start_combat',
  'phase_start_build',
  'phase_start_cannon',
  'countdown_tick',
  'enclosure_success',
  'enclosure_failed',
  'player_eliminated',
  'victory',
  'defeat',
  'ui_click',
  'ui_back',
] as const;
export type SfxCue = (typeof SFX_CUES)[number];

export const MUSIC_CUES = ['music_lobby', 'music_combat', 'music_build', 'music_gameover'] as const;
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
