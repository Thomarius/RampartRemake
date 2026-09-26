import { teamScore, type MatchState, type PlayerState } from '@rampart/sim';

/**
 * What the HUD says about points: the round against the cap, the standings, and who
 * won. Plain text, so the caller decides how it is escaped.
 *
 * Separated from the drawing so it can be tested without a browser, as `banners.ts`
 * is — the standings are shown by an announcement that only runs on the clock, which
 * headless Chrome cannot drive.
 */

export interface Standing {
  player: number;
  name: string;
  score: number;
  eliminated: boolean;
}

/**
 * Everyone, best placed first. Those still in come before those who are out whatever
 * their points, because being out loses to any score. Ties break on seat, so the
 * order never flickers between frames.
 */
export function standings(state: MatchState): Standing[] {
  return (state.players as readonly PlayerState[])
    .map((p) => ({ player: p.id, name: p.name, score: p.score, eliminated: p.eliminated }))
    .sort(
      (a, b) =>
        Number(a.eliminated) - Number(b.eliminated) || b.score - a.score || a.player - b.player,
    );
}

/** A team's name as players see it: A, B, C, D. */
export function teamLetter(team: number): string {
  return String.fromCharCode(65 + team);
}

/** Whether this is a team match rather than free-for-all's teams of one. */
export function isTeamMatch(state: MatchState): boolean {
  const sizes = new Map<number, number>();
  for (const p of state.players) sizes.set(p.team, (sizes.get(p.team) ?? 0) + 1);
  return [...sizes.values()].some((size) => size > 1);
}

export interface TeamStanding {
  team: number;
  /** Member player ids, in player order. */
  members: number[];
  score: number;
  eliminated: boolean;
}

/**
 * Every team, best placed first, by the sum of its members' scores — the score a team
 * match is decided on. As with players, a team still in comes before one that is out.
 */
export function teamStandings(state: MatchState): TeamStanding[] {
  const teams = [...new Set(state.players.map((p) => p.team))];
  return teams
    .map((team) => {
      const members = state.players.filter((p) => p.team === team);
      return {
        team,
        members: members.map((p) => p.id),
        score: teamScore(state, team),
        eliminated: members.every((p) => p.eliminated),
      };
    })
    .sort(
      (a, b) => Number(a.eliminated) - Number(b.eliminated) || b.score - a.score || a.team - b.team,
    );
}

export function roundLabel(state: MatchState): string {
  const cap = state.ruleset.scoring.maxRounds;
  return cap === null ? `round ${state.round}` : `round ${state.round} / ${cap}`;
}

/**
 * Whether the combat phase about to begin opens the last round. Asked during the
 * intermission before it, while `round` still holds the one just finished.
 */
export function finalRoundNext(state: MatchState): boolean {
  const cap = state.ruleset.scoring.maxRounds;
  return (
    cap !== null &&
    state.phase === 'intermission' &&
    state.pendingPhase === 'combat' &&
    state.round + 1 === cap
  );
}

export function standingsLine(state: MatchState): string {
  if (isTeamMatch(state)) {
    return teamStandings(state)
      .map((s) => `Team ${teamLetter(s.team)} ${s.score}${s.eliminated ? ' (out)' : ''}`)
      .join(' · ');
  }
  return standings(state)
    .map((s) => `${s.name} ${s.score}${s.eliminated ? ' (out)' : ''}`)
    .join(' · ');
}

export interface AnnouncementLine {
  text: string;
  /** Set in the accent colour: news, rather than the standings' plain record. */
  emphasis: boolean;
}

/**
 * The lines carried under a phase announcement. The standings follow a resolution,
 * which is the only time scores change, so the leaderboard costs no pause of its own.
 */
export function announcementLines(state: MatchState, afterResolution: boolean): AnnouncementLine[] {
  const lines: AnnouncementLine[] = [];
  if (finalRoundNext(state)) lines.push({ text: 'Final round', emphasis: true });
  if (afterResolution) lines.push({ text: standingsLine(state), emphasis: false });
  return lines;
}

function names(list: readonly string[]): string {
  if (list.length <= 1) return list[0] ?? '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** The headline once a match is over, from the point of view of `humanPlayer`. */
export function endOfMatchText(state: MatchState, humanPlayer: number): string {
  if (state.draw) return 'Draw — nobody held a castle';
  const { winners } = state;
  if (winners.length === 0) return 'Nobody wins';

  const onPoints = state.endedBy === 'round_cap' ? ' on points' : '';
  if (isTeamMatch(state)) {
    // A team wins or loses whole, so the headline names teams, not their members.
    const teams = [...new Set(winners.map((id) => state.players[id]?.team ?? 0))];
    const yours = state.players[humanPlayer]?.team;
    if (teams.length === 1) {
      return teams[0] === yours
        ? `Your team wins${onPoints}`
        : `Team ${teamLetter(teams[0] as number)} wins${onPoints}`;
    }
    const letters = names(teams.map(teamLetter));
    return yours !== undefined && teams.includes(yours)
      ? `Your team shares the win${onPoints}`
      : `Teams ${letters} share the win${onPoints}`;
  }
  if (winners.length === 1) {
    const winner = winners[0] as number;
    return winner === humanPlayer
      ? `You win${onPoints}`
      : `${state.players[winner]?.name ?? 'Nobody'} wins${onPoints}`;
  }
  // A shared win is a win for each of them, not a draw.
  if (winners.includes(humanPlayer)) return `You share the win${onPoints}`;
  return `${names(winners.map((id) => state.players[id]?.name ?? '?'))} share the win${onPoints}`;
}
