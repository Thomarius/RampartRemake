import { Structure, ticksFor, type MatchState, type Phase } from '@rampart/sim';

/**
 * The phase banners, and what they do to the board as they cross it.
 *
 * As in the original, the match has two looks: a plain one for building and a more
 * cinematic one for combat. The banners either side of combat swap one for the other as
 * they pass down the screen — the board above the banner already in the new look, below
 * it still in the old — and the banner after the build phase carries the sweep of loose
 * wall, each block going as the banner reaches it.
 *
 * Separated from the drawing so it can be tested without a browser: headless Chrome
 * cannot drive anything timed, and these are exactly the decisions a person watching
 * would only notice were wrong a dozen rounds in.
 */

/** Which of the two configured styles draws the board. */
export type Look = 'build' | 'combat';

/** The look a phase is played in: combat for combat, build for everything else. */
export function lookOf(phase: Phase): Look {
  return phase === 'combat' ? 'combat' : 'build';
}

/**
 * The look before and after the banner of the current intermission — or the phase's own
 * look twice, outside one.
 *
 * From state alone, so a client joining mid-intermission gets it right without having
 * seen the phase that came before: only combat leads to the build phase, so an
 * intermission heading there follows combat, and every other one follows a build-look
 * phase. The rare round in which nobody has cannons to place goes from the build phase
 * straight to combat, and comes out right with no rule of its own.
 */
export function looksAround(state: MatchState): { before: Look; after: Look } {
  if (state.phase !== 'intermission') {
    const look = lookOf(state.phase);
    return { before: look, after: look };
  }
  return {
    before: state.pendingPhase === 'build' ? 'combat' : 'build',
    after: state.pendingPhase === 'combat' ? 'combat' : 'build',
  };
}

/**
 * How far the announcement has crossed the screen, from 0 as it enters at the top to 1
 * as it leaves at the bottom, or null when none is showing.
 *
 * It occupies the end of the intermission, after the pause, and the next phase begins on
 * the tick it leaves. Driven by the simulation clock rather than a stylesheet, so the
 * wipe beneath it is always exactly where the banner is — through dropped frames, at
 * `&speed=`, and for a client that joins halfway through one.
 */
export function bannerProgress(state: MatchState, tickFraction: number): number | null {
  if (state.phase !== 'intermission' || state.pendingPhase === null) return null;
  const { transitionBannerMs } = state.ruleset.phases;
  const span = ticksFor(transitionBannerMs, state.ruleset.tickRateHz);
  if (span <= 0) return null;
  const elapsed = state.tick + tickFraction - (state.phaseEndTick - span);
  if (elapsed < 0) return null;
  return Math.min(1, elapsed / span);
}

/** A wall block the sim has swept, and whose it was. */
export interface SweptWall {
  index: number;
  /** As in `MatchState.owner`: the owning island's id, 0 for rubble. */
  owner: number;
}

/**
 * The swept blocks the banner has not reached yet, given where its line is in tile
 * rows (fractional, and anything above the board while it has not arrived).
 *
 * A block goes once the line has passed its middle, so a row goes together.
 */
export function stillStanding(
  swept: readonly SweptWall[],
  width: number,
  lineRow: number,
): SweptWall[] {
  return swept.filter((wall) => Math.floor(wall.index / width) + 0.5 > lineRow);
}

/**
 * The board to draw: the state's, with the swept blocks still standing put back.
 *
 * The sim sweeps at the resolution, before the banner shows, and it is right to: nothing
 * is playable until the banner has left. Only the drawing waits.
 */
export function boardWithStanding(
  state: MatchState,
  standing: readonly SweptWall[],
): { structure: Uint8Array; owner: Uint8Array } {
  if (standing.length === 0) return { structure: state.structure, owner: state.owner };
  const structure = state.structure.slice();
  const owner = state.owner.slice();
  for (const wall of standing) {
    // A cannon placed there would be a contradiction, but the phase that allows one
    // begins only once the banner has taken the block away.
    if (structure[wall.index] !== Structure.Empty) continue;
    structure[wall.index] = Structure.Wall;
    owner[wall.index] = wall.owner;
  }
  return { structure, owner };
}

/** A wall block lost with a life, and when it crumbles. */
export interface Ruin extends SweptWall {
  dueMs: number;
}

/**
 * The walls an island lost when its owner spent a life: standing on the board as it was
 * last drawn, owned by that island, and gone from the state now. The sim wipes the island
 * in one step; the client takes them down over a moment instead.
 */
export function lostWalls(
  drawnStructure: Uint8Array,
  drawnOwner: Uint8Array,
  structureNow: Uint8Array,
  island: number,
): SweptWall[] {
  const lost: SweptWall[] = [];
  for (let i = 0; i < structureNow.length; i++) {
    if (drawnStructure[i] !== Structure.Wall || drawnOwner[i] !== island) continue;
    if (structureNow[i] === Structure.Wall) continue;
    lost.push({ index: i, owner: island });
  }
  return lost;
}

/**
 * When each lost block crumbles: outward from the middle of the island over `spanMs`, so
 * the fall spreads from the heart of the failed defence to its edges rather than the
 * whole wall blinking out.
 */
export function crumbleOutward(
  walls: readonly SweptWall[],
  width: number,
  centre: { x: number; y: number },
  startMs: number,
  spanMs: number,
): Ruin[] {
  const distance = (index: number): number => {
    const x = index % width;
    const y = (index - x) / width;
    return Math.hypot(x - centre.x, y - centre.y);
  };
  const farthest = walls.reduce((most, wall) => Math.max(most, distance(wall.index)), 0);
  return walls.map((wall) => ({
    ...wall,
    dueMs: startMs + (farthest === 0 ? 0 : (distance(wall.index) / farthest) * spanMs),
  }));
}
