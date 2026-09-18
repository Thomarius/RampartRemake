import { defaultArtConfig } from '@rampart/config';
import {
  PIECE_CATALOGUE,
  currentPieceId,
  pieceCells,
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

function playerColour(player: number): string {
  const entry = defaultArtConfig.players[player % defaultArtConfig.players.length];
  return entry ? entry.base : '#ffffff';
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

  /**
   * Announces a phase with a banner that sweeps down the screen, as the original
   * did. Phases change without warning otherwise, and a player who does not notice
   * that combat has ended spends the first seconds of the build phase shooting.
   */
  announce(phase: Phase, durationMs: number): void {
    const text = PHASE_CALL[phase];
    if (text === '') return;
    const banner = document.createElement('div');
    banner.className = 'phase-call';
    banner.textContent = text;
    // The simulation holds the next phase until this has left the screen, so the
    // travel time comes from the ruleset rather than the stylesheet.
    banner.style.animationDuration = `${durationMs}ms`;
    banner.addEventListener('animationend', () => banner.remove());
    this.bannerRoot.replaceChildren(banner);
  }

  update(state: MatchState, humanPlayer: number, status = ''): void {
    const waiting = state.phase === 'intermission';
    const shown = waiting ? (state.pendingPhase ?? state.phase) : state.phase;
    const secondsLeft = Math.max(0, (state.phaseEndTick - state.tick) / state.ruleset.tickRateHz);
    const human = state.players[humanPlayer];
    const colour = playerColour(humanPlayer);

    const roster = state.players
      .map((p) => {
        const cannons = state.cannons.filter((c) => c.owner === p.id);
        const live = cannons.filter((c) => c.active).length;
        const classes = ['player', p.eliminated ? 'out' : '', p.id === humanPlayer ? 'you' : '']
          .filter(Boolean)
          .join(' ');
        const status = p.eliminated
          ? `eliminated round ${p.eliminatedRound}`
          : `${p.enclosedCastles} castle${p.enclosedCastles === 1 ? '' : 's'} · ${live}/${cannons.length} guns`;
        return `<li class="${classes}"><b style="background:${playerColour(p.id)}"></b>${p.name}<span>${status}</span></li>`;
      })
      .join('');

    let cannonCount = '';
    if (state.phase === 'cannon_place' && human && !human.eliminated) {
      const left = human.cannonsToPlace;
      cannonCount =
        left > 0
          ? `<div class="counter">${left} cannon${left === 1 ? '' : 's'} left to place</div>`
          : `<div class="counter done">All cannons placed</div>`;
    }

    let queue = '';
    if (state.phase === 'build' && human && !human.eliminated) {
      const next = upcomingPieceIds(state, humanPlayer, state.ruleset.build.previewCount);
      queue =
        `<div class="queue"><span class="label">Holding</span>${pieceSwatch(currentPieceId(state, humanPlayer), colour, 11)}` +
        (next.length > 0
          ? `<span class="label">Next</span>${next.map((id) => pieceSwatch(id, colour, 7)).join('')}`
          : '') +
        `</div>`;
    }

    let banner = '';
    if (state.phase === 'game_over') {
      const text = state.draw
        ? 'Draw — nobody held a castle'
        : state.winner === humanPlayer
          ? 'You win'
          : `${state.players[state.winner ?? 0]?.name ?? 'Nobody'} wins`;
      banner = `<div class="banner">${text}<small>press R to play again</small></div>`;
    } else if (human?.eliminated) {
      banner = `<div class="banner">You were eliminated in round ${human.eliminatedRound}<small>watching the rest</small></div>`;
    }

    this.root.innerHTML = `
      <div class="bar">
        <div class="phase">
          <strong>${waiting ? `Next: ${PHASE_LABEL[shown]}` : PHASE_LABEL[shown]}</strong>
          <span class="timer">${waiting ? '&nbsp;' : `${secondsLeft.toFixed(1)}s`}</span>
          <span class="round">round ${state.round}</span>
        </div>
        <ul class="roster">${roster}</ul>
      </div>
      ${queue}
      ${cannonCount}
      <div class="hint">${PHASE_HINT[state.phase]}</div>
      ${status ? `<div class="net">${status}</div>` : ''}
      ${banner}
    `;
  }
}

export const PIECE_COUNT = PIECE_CATALOGUE.length;
