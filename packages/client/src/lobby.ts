import type { Difficulty } from '@rampart/ai';
import {
  teamsBalanced,
  validPlayerCounts,
  type MatchSettings,
  type SettingBounds,
} from '@rampart/config';
import type { Seat } from '@rampart/protocol';

/**
 * The lobby, as markup — one lobby for online and offline.
 *
 * Built as a function of the table rather than assembled in place so it can be checked
 * without a server and a browser: whether a guest is shown the host's controls is the
 * kind of thing that is obvious in the code and still wrong on the screen. The same view
 * is fed by a room when a server is reachable and by a local model when not, so the two
 * cannot grow apart.
 */

export interface LobbyView {
  /** The room's code, or null when no server could be reached and the table is local. */
  code: string | null;
  /** Seats at the table, including the ones nobody has taken. */
  playerCount: number;
  /** The host's seat. */
  hostId: number;
  /** The seat this browser holds, or -1 before the server has said. */
  humanPlayer: number;
  /** Seats people hold, by seat. The rest are played by bots. */
  seats: readonly Seat[];
  bots: readonly Difficulty[];
  settings: MatchSettings;
  settingBounds: SettingBounds;
  /** Each seat's team, by seat. */
  teams: readonly number[];
  /** Player counts the rules allow at all, before the team size narrows them. */
  playerLimits: { min: number; max: number };
}

/** What each tier actually does, since "gunner" tells a new player nothing. */
const TIER_BLURB: Record<Difficulty, string> = {
  recruit: 'wanders its aim, holds one castle',
  gunner: 'finds the weak point, reaches for two',
  marshal: 'rarely misses, and rethinks constantly',
  baron: 'reaches for the next castle the moment it holds one',
};

const TIERS: Difficulty[] = ['recruit', 'gunner', 'marshal', 'baron'];

/** A team's name as players see it: A, B, C, D. */
export function teamLetter(team: number): string {
  return String.fromCharCode(65 + team);
}

function label(tier: string): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

export function escape(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

/** Every whole number in a range, as options with one selected. */
export function rangeOptions(min: number, max: number, selected: number): string {
  return Array.from({ length: max - min + 1 }, (_, i) => min + i)
    .map((n) => `<option value="${n}"${n === selected ? ' selected' : ''}>${n}</option>`)
    .join('');
}

function options(
  values: readonly number[],
  selected: number,
  name: (n: number) => string = String,
): string {
  return values
    .map((n) => `<option value="${n}"${n === selected ? ' selected' : ''}>${name(n)}</option>`)
    .join('');
}

/** Team sizes that make at least one table seating everyone who has joined. */
export function teamSizesFor(view: LobbyView): number[] {
  const { min, max } = view.settingBounds.teamSize;
  const out: number[] = [];
  for (let size = min; size <= max; size++) {
    const counts = validPlayerCounts(size, view.playerLimits);
    if (counts.some((n) => n >= view.seats.length)) out.push(size);
  }
  return out;
}

/** The table's settings: controls for the host, a statement for everyone else. */
function tableControls(view: LobbyView, isHost: boolean): string {
  const { maxRounds, teamSize } = view.settings;
  const teamName = (size: number): string => (size === 1 ? 'Free-for-all' : `Teams of ${size}`);
  if (!isHost) {
    return `<p class="note settings">${view.playerCount} players · ${teamName(teamSize)} · ${maxRounds} rounds, then the best score wins.</p>`;
  }
  const counts = validPlayerCounts(teamSize, view.playerLimits).filter(
    (n) => n >= view.seats.length,
  );
  const { min, max } = view.settingBounds.maxRounds;
  return `
    <div class="settings">
      <label>Teams
        <select id="team-size" aria-label="Team size">${options(teamSizesFor(view), teamSize, teamName)}</select>
      </label>
      <label>Players
        <select id="player-count" aria-label="Players">${options(counts, view.playerCount)}</select>
      </label>
      <label>Rounds
        <select id="max-rounds" aria-label="Rounds">${rangeOptions(min, max, maxRounds)}</select>
      </label>
    </div>`;
}

function teamCell(view: LobbyView, index: number, isHost: boolean): string {
  if (view.settings.teamSize === 1) return '';
  const team = view.teams[index] ?? 0;
  const count = view.playerCount / view.settings.teamSize;
  if (!isHost) return `<em class="tag team">Team ${teamLetter(team)}</em>`;
  const choices = Array.from({ length: count }, (_, t) => t);
  return `<select class="team-select" data-seat="${index}" aria-label="Seat ${index + 1} team">${options(
    choices,
    team,
    (t) => `Team ${teamLetter(t)}`,
  )}</select>`;
}

function seatRow(view: LobbyView, index: number, isHost: boolean, explain: boolean): string {
  const seat = view.seats.find((s) => s.playerId === index);
  const team = teamCell(view, index, isHost);

  if (seat) {
    const tags = [
      seat.playerId === view.humanPlayer ? '<em class="tag you">you</em>' : '',
      seat.playerId === view.hostId ? '<em class="tag">host</em>' : '',
      seat.connected ? '' : '<em class="tag away">away</em>',
    ].join('');
    const mine = seat.playerId === view.humanPlayer ? ' you' : '';
    return `<li class="seat${mine}"><span class="who">${escape(seat.name)}</span>${tags}${team}</li>`;
  }

  const tier = view.bots[index] ?? 'gunner';
  const control = isHost
    ? `<select class="bot-select" data-seat="${index}" aria-label="Seat ${index + 1} bot skill">${TIERS.map(
        (t) => `<option value="${t}"${t === tier ? ' selected' : ''}>${label(t)}</option>`,
      ).join('')}</select>`
    : `<em class="tag">${label(tier)}</em>`;
  // Explained once per tier rather than once per seat: eight bots on the same setting
  // produced eight identical lines of explanation, which reads as noise and buries the
  // one line that is doing the work.
  const blurb = explain ? `<small class="blurb">${TIER_BLURB[tier]}</small>` : '';
  return `<li class="seat bot"><span class="who">Bot ${index + 1}</span>${control}${team}${blurb}</li>`;
}

/** Whether the table can start as it stands, and if not, why not. */
export function startBlocked(view: LobbyView): string | null {
  if (!teamsBalanced([...view.teams], view.settings.teamSize)) {
    return `Teams must be the same size: ${view.settings.teamSize} each.`;
  }
  return null;
}

export function lobbyMarkup(view: LobbyView): string {
  const isHost = view.humanPlayer === view.hostId;
  const taken = view.seats.length;
  const alone = taken <= 1;
  // One string, not a wrapped template: the sentence is read, and matched, as a whole.
  const note =
    view.code === null
      ? 'No server to reach, so this table is on this computer only.'
      : `Share this code. ${taken} of ${view.playerCount} seat${view.playerCount === 1 ? '' : 's'} taken` +
        (taken < view.playerCount ? ' — the rest are played by bots.' : '.') +
        (alone && isHost ? ' If nobody joins, the match runs on this computer.' : '');
  const explained = new Set<Difficulty>();
  const rows = Array.from({ length: view.playerCount }, (_, i) => {
    const seatTaken = view.seats.some((seat) => seat.playerId === i);
    const tier = view.bots[i] ?? 'gunner';
    const first = !seatTaken && !explained.has(tier);
    if (first) explained.add(tier);
    return seatRow(view, i, isHost, first);
  }).join('');

  const blocked = startBlocked(view);
  const start = !isHost
    ? '<p class="note">Waiting for the host to start.</p>'
    : `<button id="begin"${blocked === null ? '' : ' disabled'}>Start match</button>` +
      (blocked === null ? '' : `<p class="note warn">${escape(blocked)}</p>`) +
      // Watching is a local match of bots only, so it is offered while nobody else has
      // joined — once they have, the table is theirs too.
      (alone ? '<button id="watch" class="quiet">Watch the bots play</button>' : '');

  const code =
    view.code === null
      ? ''
      : `<div class="code-row">
        <code id="room-code" class="room-code">${escape(view.code)}</code>
        <button id="copy-code" class="quiet">Copy</button>
      </div>`;

  return `
    <div class="menu lobby">
      <h1>${view.code === null ? 'Table' : 'Room'}</h1>
      ${code}
      <p class="note">${note}</p>
      ${tableControls(view, isHost)}
      <ul class="seats">${rows}</ul>
      ${start}
      <button id="leave" class="quiet">Leave</button>
    </div>
  `;
}
