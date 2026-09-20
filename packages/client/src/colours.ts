import { defaultArtConfig } from '@rampart/config';

/**
 * A player's colour as CSS.
 *
 * The same ramp the renderer uses, so a seat in the lobby, a name in the roster and the
 * walls on the board are recognisably one player. Cycles if a match ever has more
 * players than the palette defines, which the config validator makes unlikely.
 */
export function playerCssColour(player: number): string {
  const entry = defaultArtConfig.players[player % defaultArtConfig.players.length];
  return entry ? entry.base : '#ffffff';
}
