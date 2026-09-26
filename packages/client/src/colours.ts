import { defaultArtConfig, type ArtConfig, type PlayerPalette } from '@rampart/config';
import type { MatchState } from '@rampart/sim';

/**
 * Each player's colours for this match, by player id.
 *
 * Free-for-all uses the eight distinct colours of `players`. A team match gives each
 * team one family of hues and each member a shade of it, in player order within the
 * team, so a team reads as one colour while every player keeps their own.
 */
export function matchPalette(art: ArtConfig, state: MatchState): PlayerPalette[] {
  const teamSizes = new Map<number, number>();
  for (const p of state.players) teamSizes.set(p.team, (teamSizes.get(p.team) ?? 0) + 1);
  const teamed = [...teamSizes.values()].some((size) => size > 1);
  if (!teamed) return state.players.map((p) => art.players[p.id % art.players.length]!);

  const rank = new Map<number, number>();
  return state.players.map((p) => {
    const k = rank.get(p.team) ?? 0;
    rank.set(p.team, k + 1);
    const family = art.teamFamilies[p.team % art.teamFamilies.length]!;
    return family[k % family.length]!;
  });
}

/** The palette the HUD's colours are drawn from; the match's once one is running. */
let active: readonly PlayerPalette[] = defaultArtConfig.players;

/** Makes a match's palette the one every HUD colour below is drawn from. */
export function useMatchPalette(palette: readonly PlayerPalette[]): void {
  active = palette;
}

/**
 * A player's colour as CSS.
 *
 * The same ramp the renderer uses, so a name in the roster and the walls on the board are
 * recognisably one player. Cycles if a match ever has more players than the palette
 * defines, which the config validator makes unlikely.
 */
export function playerCssColour(player: number): string {
  const entry = active[player % active.length];
  return entry ? entry.base : '#ffffff';
}
