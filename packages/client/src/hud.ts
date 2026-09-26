import { playerCssColour } from './colours.js';
import type { BannerKind } from './banners.js';
import { escape } from './lobby.js';
import {
  endOfMatchText,
  isTeamMatch,
  roundLabel,
  standings,
  teamLetter,
  teamStandings,
  type AnnouncementLine,
} from './scores.js';
import {
  PIECE_CATALOGUE,
  currentPieceId,
  owesCastleChoice,
  pieceCells,
  teamScore,
  upcomingPieceIds,
  type MatchState,
  type Phase,
} from '@rampart/sim';

const PHASE_LABEL: Record<Phase, string> = {
  lobby: 'Waiting',
  intermission: 'Stand by',
  castle_select: 'Choose your castle',
  combat: 'Fire!',
  build: 'Rebuild your walls',
  cannon_place: 'Place your cannons',
  game_over: 'Game over',
};

const PHASE_HINT: Record<Phase, string> = {
  lobby: '',
  intermission: '',
  castle_select: 'Click a castle on your island',
  combat: 'Click to fire the nearest ready cannon',
  build: 'Click to place · R / wheel / right-click to rotate',
  cannon_place: 'Click inside your own sealed territory',
  game_over: '',
};

/** One banner over one island. */
export interface IslandBanner {
  player: number;
  colour: string;
  /** How long a banner of news that expires is held, so its fade can match. */
  holdMs: number;
  kind: BannerKind;
  title: string;
  detail: string;
  urgent: boolean;
  /** Screen pixels, from `Scene.screenAt`. */
  x: number;
  y: number;
}

/** A piece drawn as a small grid of cells, for the preview strip. */
function pieceSwatch(pieceId: number, colour: string, scale: number): string {
  const cells = pieceCells(pieceId, 0);
  const w = Math.max(...cells.map(([x]) => x)) + 1;
  const h = Math.max(...cells.map(([, y]) => y)) + 1;
  const boxes = cells
    .map(
      ([x, y]) =>
        `<i style="left:${x * scale}px;top:${y * scale}px;width:${scale - 1}px;height:${scale - 1}px;background:${colour}"></i>`,
    )
    .join('');
  return `<span class="swatch" style="width:${w * scale}px;height:${h * scale}px">${boxes}</span>`;
}

/** Short, shouted names for the sweeping phase announcement. */
const PHASE_CALL: Record<Phase, string> = {
  lobby: '',
  intermission: '',
  castle_select: 'Choose your castle',
  combat: 'Fire!',
  build: 'Rebuild',
  cannon_place: 'Place cannons',
  game_over: '',
};

export class Hud {
  constructor(
    private readonly root: HTMLElement,
    private readonly bannerRoot: HTMLElement,
  ) {}

  /** When the phase on screen began, so the time bar knows its whole length. */
  private phaseKey = '';
  private phaseStartTick = 0;

  /** The announcement crossing the screen, if one is. */
  private phaseCall: HTMLElement | null = null;

  /** A team's letter over each of its islands, for the whole of a team match. */
  private teamTags = new Map<number, HTMLElement>();

  showTeamTags(
    tags: readonly { player: number; text: string; colour: string; x: number; y: number }[],
  ): void {
    for (const tag of tags) {
      let node = this.teamTags.get(tag.player);
      if (node === undefined) {
        node = document.createElement('div');
        node.className = 'team-tag';
        node.textContent = tag.text;
        this.bannerRoot.append(node);
        this.teamTags.set(tag.player, node);
      }
      node.style.borderColor = tag.colour;
      node.style.left = `${tag.x}px`;
      node.style.top = `${tag.y}px`;
    }
  }

  /** Kept across frames, like the island banners, rather than rebuilt from markup. */
  private bigTimer: HTMLElement | null = null;
  private readyCount: HTMLElement | null = null;

  /**
   * The time left in large figures, in open water near the middle of the map — see
   * `timerSpot`. Null hides it. Red for the last three seconds, like the bar.
   */
  showBigTimer(at: { x: number; y: number; sizePx: number } | null, seconds: number): void {
    if (at === null) {
      this.bigTimer?.remove();
      this.bigTimer = null;
      return;
    }
    if (this.bigTimer === null) {
      this.bigTimer = document.createElement('div');
      this.bigTimer.className = 'big-timer';
      this.bannerRoot.append(this.bigTimer);
    }
    const text = String(seconds);
    if (this.bigTimer.textContent !== text) this.bigTimer.textContent = text;
    this.bigTimer.classList.toggle('urgent', seconds <= 3);
    this.bigTimer.style.left = `${at.x}px`;
    this.bigTimer.style.top = `${at.y}px`;
    this.bigTimer.style.fontSize = `${Math.round(at.sizePx * 0.75)}px`;
  }

  /** How many cannons are ready, beside the aiming cursor. Null hides it. */
  showReadyCount(at: { x: number; y: number } | null, count: number): void {
    if (at === null) {
      this.readyCount?.remove();
      this.readyCount = null;
      return;
    }
    if (this.readyCount === null) {
      this.readyCount = document.createElement('div');
      this.readyCount.className = 'ready-count';
      this.bannerRoot.append(this.readyCount);
    }
    const text = String(count);
    if (this.readyCount.textContent !== text) this.readyCount.textContent = text;
    this.readyCount.classList.toggle('none', count === 0);
    this.readyCount.style.left = `${at.x}px`;
    this.readyCount.style.top = `${at.y}px`;
  }

  /** Live banner nodes by player, kept across frames so their animation survives. */
  private readonly islandBanners = new Map<number, HTMLElement>();

  /**
   * Announces a phase with a banner that sweeps down the screen, as the original
   * did. Phases change without warning otherwise, and a player who does not notice
   * that combat has ended spends the first seconds of the build phase shooting.
   *
   * `lines` ride along underneath — the standings after a resolution, and the call
   * for the final round — so neither needs a pause of its own. It enters above the top
   * of the screen; `placeAnnouncement` moves it from there.
   */
  announce(phase: Phase, lines: readonly AnnouncementLine[] = []): void {
    this.clearAnnouncement();
    const text = PHASE_CALL[phase];
    if (text === '') return;
    const banner = document.createElement('div');
    banner.className = 'phase-call';
    banner.textContent = text;
    for (const line of lines) {
      const small = document.createElement('small');
      small.textContent = line.text;
      if (line.emphasis) small.className = 'news';
      banner.append(small);
    }
    // Replace only the last announcement. This layer also holds everything else drawn
    // over the board — the island banners, the team tags, the big timer, the cannon
    // count at the cursor — and clearing it all left those updating nodes no longer on
    // the page, so the count vanished for good at the first announcement.
    this.phaseCall = banner;
    this.bannerRoot.append(banner);
  }

  /**
   * Puts the announcement `progress` of the way down the screen — 0 wholly above it,
   * 1 wholly below — and returns the height of its middle in pixels, which is where the
   * board changes beneath it. Null when there is no announcement.
   *
   * At constant speed, with no dwell: the banner sweeps past rather than stopping to be
   * read. The simulation holds the next phase until it has left.
   */
  placeAnnouncement(progress: number): number | null {
    const banner = this.phaseCall;
    if (banner === null) return null;
    const screen = this.bannerRoot.clientHeight;
    const height = banner.offsetHeight;
    const top = -height + progress * (screen + height);
    banner.style.transform = `translateY(${top.toFixed(1)}px)`;
    return top + height / 2;
  }

  clearAnnouncement(): void {
    this.phaseCall?.remove();
    this.phaseCall = null;
  }

  /**
   * Banners sitting over the islands themselves: a life lost, or a player out.
   *
   * Placed rather than templated, because they move with the camera and rebuilding
   * them from a string every frame would restart their animation on every frame.
   */
  showIslandBanners(banners: IslandBanner[]): void {
    const wanted = new Map(banners.map((b) => [b.player, b]));

    for (const [player, node] of this.islandBanners) {
      if (wanted.has(player)) continue;
      node.remove();
      this.islandBanners.delete(player);
    }

    for (const banner of banners) {
      let node = this.islandBanners.get(banner.player);
      if (node === undefined) {
        node = document.createElement('div');
        node.className = 'island-banner';
        this.bannerRoot.append(node);
        this.islandBanners.set(banner.player, node);
      }
      const text = `${banner.title}|${banner.detail}`;
      if (node.dataset.text !== text) {
        node.dataset.text = text;
        const title = document.createElement('strong');
        title.textContent = banner.title;
        node.replaceChildren(title);
        if (banner.detail !== '') {
          const detail = document.createElement('small');
          detail.textContent = banner.detail;
          node.append(detail);
        }
      }
      // A new kind of news restarts the entrance, so a life lost after points were shown
      // lands as hard as one on its own. Only a new kind: points counting up change the
      // text every frame, and restarting then would replay the entrance every frame.
      if (node.dataset.kind !== banner.kind) {
        node.dataset.kind = banner.kind;
        node.className = `island-banner ${banner.kind}`;
        node.style.animationDuration = banner.kind === 'gain' ? `${banner.holdMs}ms` : '';
      }
      node.classList.toggle('urgent', banner.urgent);
      node.style.borderColor = banner.colour;
      node.style.left = `${banner.x}px`;
      node.style.top = `${banner.y}px`;
    }
  }

  /** `sealed` is castles enclosed as the board stands now, which the sim's count is not. */
  update(
    state: MatchState,
    humanPlayer: number,
    status = '',
    sealed: readonly number[] = state.players.map((p) => p.enclosedCastles),
  ): void {
    const waiting = state.phase === 'intermission';
    const shown = waiting ? (state.pendingPhase ?? state.phase) : state.phase;
    const secondsLeft = Math.max(0, (state.phaseEndTick - state.tick) / state.ruleset.tickRateHz);

    // A bar reads at the edge of vision in a way a number does not — the player is
    // looking at their wall, not at the corner of the screen. Red for the last few
    // seconds, when it matters most.
    const key = `${state.phase}:${state.phaseEndTick}`;
    if (key !== this.phaseKey) {
      this.phaseKey = key;
      this.phaseStartTick = state.tick;
    }
    const span = Math.max(1, state.phaseEndTick - this.phaseStartTick);
    const left = Math.min(1, Math.max(0, (state.phaseEndTick - state.tick) / span));
    const timebar =
      waiting || state.phase === 'game_over'
        ? ''
        : `<div class="timebar${secondsLeft <= 3 ? ' urgent' : ''}"><i style="width:${(left * 100).toFixed(1)}%"></i></div>`;
    const human = state.players[humanPlayer];
    const colour = playerCssColour(humanPlayer);

    // Lives as pips, one per life including the one being played, spent ones hollow:
    // read at a glance across a roster, where "2 lives" had to be read word by word.
    // They are the team's pool — in free-for-all a team of one, so the player's own.
    const livesOf = (team: number): string => {
      const pool = state.teams[team];
      const total = (pool?.continuesAtStart ?? 0) + 1;
      const left = (pool?.continuesRemaining ?? 0) + 1;
      const pips = '●'.repeat(left) + '○'.repeat(Math.max(0, total - left));
      return `<span class="lives${left === 1 ? ' last' : ''}" title="${left} of ${total} lives">${pips}</span>`;
    };
    const teamed = isTeamMatch(state);
    const playerItem = (p: (typeof state.players)[number]): string => {
      const cannons = state.cannons.filter((c) => c.owner === p.id);
      const live = cannons.filter((c) => c.active).length;
      const classes = ['player', p.eliminated ? 'out' : '', p.id === humanPlayer ? 'you' : '']
        .filter(Boolean)
        .join(' ');
      const castles = `${sealed[p.id] ?? 0} castle${sealed[p.id] === 1 ? '' : 's'}`;
      // In a team match the score and lives belong to the team, so they head its group.
      // Past four players a team's members get only their names: their team's score and
      // lives head the group, their castles fly banners on the board, and the details
      // wrapped a crowded bar onto two lines.
      const status = p.eliminated
        ? `eliminated round ${p.eliminatedRound}`
        : teamed && state.players.length > 4
          ? ''
          : teamed
            ? `${castles} · ${live}/${cannons.length} guns`
            : `${p.score} pts · ${castles} · ${live}/${cannons.length} guns · ${livesOf(p.team)}`;
      return `<li class="${classes}"><b style="background:${playerCssColour(p.id)}"></b>${escape(p.name)}<span>${status}</span></li>`;
    };
    // A team match groups the roster by team, in team order so it never reshuffles as
    // scores change, each headed by its letter, score and pooled lives.
    const roster = teamed
      ? [...new Set(state.players.map((p) => p.team))]
          .sort((a, b) => a - b)
          .map((team) => {
            const members = state.players.filter((p) => p.team === team);
            const out = members.every((p) => p.eliminated);
            const mine = members.some((p) => p.id === humanPlayer);
            return (
              `<li class="team${out ? ' out' : ''}${mine ? ' mine' : ''}">` +
              `<div class="team-head"><b class="letter">${teamLetter(team)}</b>${teamScore(state, team)} pts · ${out ? 'out' : livesOf(team)}</div>` +
              `<ul>${members.map(playerItem).join('')}</ul></li>`
            );
          })
          .join('')
      : state.players.map(playerItem).join('');

    // A player who has just spent a continue chooses a castle in the cannon phase
    // before any guns, so for them this phase is a castle choice first.
    const choosing =
      human !== undefined &&
      owesCastleChoice(human) &&
      (shown === 'cannon_place' || shown === 'castle_select');
    // Overtime: the clock has run out and one more piece may go down.
    const overtime = state.phase === 'build' && state.overtime;
    const label = choosing
      ? PHASE_LABEL.castle_select
      : overtime
        ? 'Overtime — last piece'
        : PHASE_LABEL[shown];

    let cannonCount = '';
    if (state.phase === 'cannon_place' && human && !human.eliminated) {
      const left = human.cannonsToPlace;
      cannonCount = choosing
        ? `<div class="counter">Choose a castle — then ${left} cannon${left === 1 ? '' : 's'} to place</div>`
        : left > 0
          ? `<div class="counter">${left} cannon${left === 1 ? '' : 's'} left to place</div>`
          : `<div class="counter done">All cannons placed</div>`;
    }

    let queue = '';
    // In overtime there is no next piece to preview, and once the last is down nothing
    // to hold either.
    if (
      state.phase === 'build' &&
      human &&
      !human.eliminated &&
      !(overtime && human.overtimeSpent)
    ) {
      const next = overtime
        ? []
        : upcomingPieceIds(state, humanPlayer, state.ruleset.build.previewCount);
      queue =
        `<div class="queue"><span class="label">Holding</span>${pieceSwatch(currentPieceId(state, humanPlayer), colour, 11)}` +
        (next.length > 0
          ? `<span class="label">Next</span>${next.map((id) => pieceSwatch(id, colour, 7)).join('')}`
          : '') +
        `</div>`;
    }

    let banner = '';
    if (state.phase === 'game_over') {
      const text = escape(endOfMatchText(state, humanPlayer));
      // A table rather than a line: with more than three players a single line of
      // names and numbers could not be read at a glance.
      const rows = teamed
        ? teamStandings(state)
            .map((s, rank) => {
              const mine = s.members.includes(humanPlayer);
              const members = s.members
                .map(
                  (id) =>
                    `<b style="background:${playerCssColour(id)}"></b>${escape(state.players[id]?.name ?? '')}`,
                )
                .join(' ');
              return (
                `<tr class="${s.eliminated ? 'out' : ''}${mine ? ' you' : ''}">` +
                `<td>${rank + 1}</td><td>Team ${teamLetter(s.team)} · ${members}</td>` +
                `<td>${s.score}</td><td>${s.eliminated ? 'out' : ''}</td></tr>`
              );
            })
            .join('')
        : standings(state)
            .map(
              (s, rank) =>
                `<tr class="${s.eliminated ? 'out' : ''}${s.player === humanPlayer ? ' you' : ''}">` +
                `<td>${rank + 1}</td><td><b style="background:${playerCssColour(s.player)}"></b>${escape(s.name)}</td>` +
                `<td>${s.score}</td><td>${s.eliminated ? 'out' : ''}</td></tr>`,
            )
            .join('');
      const table = `<table class="final">${rows}</table>`;
      const again = humanPlayer < 0 ? 'press R for the menu' : 'press R to play again';
      banner = `<div class="banner">${text}${table}<small>${again}</small></div>`;
    }
    // Knocked out: the stamp over your island is the moment, so this is only a quiet
    // line where the controls hint was — a banner in the middle of the screen covered
    // the very match you were left to watch, for the rest of it.
    const hint = human?.eliminated
      ? `Knocked out in round ${human.eliminatedRound} · watching the rest`
      : humanPlayer < 0
        ? ''
        : choosing && !waiting
          ? PHASE_HINT.castle_select
          : overtime
            ? human?.overtimeSpent
              ? 'Last piece placed'
              : 'Place the piece you are holding · no more after it'
            : PHASE_HINT[state.phase];

    this.root.innerHTML = `
      <div class="bar">
        <div class="phase">
          <strong>${waiting ? `Next: ${label}` : label}</strong>
          ${
            // Hidden rather than removed, so the round label does not jump sideways
            // every intermission; and there is no clock to show once the match is over.
            waiting || state.phase === 'game_over'
              ? `<span class="timer" style="visibility:hidden">${secondsLeft.toFixed(1)}s</span>`
              : `<span class="timer">${secondsLeft.toFixed(1)}s</span>`
          }
          <span class="round">${roundLabel(state)}</span>
        </div>
        <ul class="roster">${roster}</ul>
      </div>
      ${timebar}
      ${queue}
      ${cannonCount}
      <div class="hint">${hint}</div>
      ${status ? `<div class="net">${status}</div>` : ''}
      ${banner}
    `;
  }
}

export const PIECE_COUNT = PIECE_CATALOGUE.length;
