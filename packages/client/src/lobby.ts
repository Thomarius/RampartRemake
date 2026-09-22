import type { Difficulty } from '@rampart/ai';
import type { MatchSettings, SettingBounds } from '@rampart/config';
import type { Seat } from '@rampart/protocol';

import { playerCssColour } from './colours.js';

/**
 * The lobby, as markup.
 *
 * Built as a function of the room rather than assembled in place so it can be checked
 * without a server and a browser: whether a guest is shown the host's controls is the
 * kind of thing that is obvious in the code and still wrong on the screen.
 */

export interface LobbyView {
  code: string;
  /** Seats at the table, including the ones nobody has taken. */
  playerCount: number;
  hostId: number;
  /** The seat this browser holds, or -1 before the server has said. */
  humanPlayer: number;
  seats: readonly Seat[];
  bots: readonly Difficulty[];
  settings: MatchSettings;
  settingBounds: SettingBounds;
}

/** What each tier actually does, since "gunner" tells a new player nothing. */
const TIER_BLURB: Record<Difficulty, string> = {
  recruit: 'wanders its aim, holds one castle',
  gunner: 'finds the weak point, reaches for two',
  marshal: 'rarely misses, and rethinks constantly',
};

const TIERS: Difficulty[] = ['recruit', 'gunner', 'marshal'];

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

/** The match settings: a control for the host, a statement for everyone else. */
function settingsRow(view: LobbyView, isHost: boolean): string {
  const { maxRounds } = view.settings;
  if (!isHost) return `<p class="note settings">${maxRounds} rounds, then the best score wins.</p>`;
  const { min, max } = view.settingBounds.maxRounds;
  return `<label class="settings">Rounds
    <select id="max-rounds" aria-label="Rounds">${rangeOptions(min, max, maxRounds)}</select>
  </label>`;
}

function seatRow(view: LobbyView, index: number, isHost: boolean, explain: boolean): string {
  const swatch = `<b class="swatch" style="background:${playerCssColour(index)}"></b>`;
  const seat = view.seats.find((s) => s.playerId === index);

  if (seat) {
    const tags = [
      seat.playerId === view.humanPlayer ? '<em class="tag you">you</em>' : '',
      seat.playerId === view.hostId ? '<em class="tag">host</em>' : '',
      seat.connected ? '' : '<em class="tag away">away</em>',
    ].join('');
    const mine = seat.playerId === view.humanPlayer ? ' you' : '';
    return `<li class="seat${mine}">${swatch}<span class="who">${escape(seat.name)}</span>${tags}</li>`;
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
  return `<li class="seat bot">${swatch}<span class="who">Bot ${index + 1}</span>${control}${blurb}</li>`;
}

export function lobbyMarkup(view: LobbyView): string {
  const isHost = view.humanPlayer === view.hostId;
  const taken = view.seats.length;
  // One string, not a wrapped template: the sentence is read, and matched, as a whole.
  const note =
    `Share this code. ${taken} of ${view.playerCount} ` +
    `seat${view.playerCount === 1 ? '' : 's'} taken` +
    (taken < view.playerCount ? ' — the rest are played by bots.' : '.');
  const explained = new Set<Difficulty>();
  const rows = Array.from({ length: view.playerCount }, (_, i) => {
    const taken = view.seats.some((seat) => seat.playerId === i);
    const tier = view.bots[i] ?? 'gunner';
    const first = !taken && !explained.has(tier);
    if (first) explained.add(tier);
    return seatRow(view, i, isHost, first);
  }).join('');

  return `
    <div class="menu lobby">
      <h1>Room</h1>
      <div class="code-row">
        <code id="room-code" class="room-code">${escape(view.code)}</code>
        <button id="copy-code" class="quiet">Copy</button>
      </div>
      <p class="note">${note}</p>
      <ul class="seats">${rows}</ul>
      ${settingsRow(view, isHost)}
      ${
        isHost
          ? '<button id="begin">Start match</button>'
          : '<p class="note">Waiting for the host to start.</p>'
      }
      <button id="leave" class="quiet">Leave</button>
    </div>
  `;
}
