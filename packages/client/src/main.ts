import {
  ArtStyleSchema,
  defaultArtConfig,
  defaultConfigBundle,
  validateConfigBundle,
  type ArtStyle,
} from '@rampart/config';
import { DIFFICULTIES, type Difficulty } from '@rampart/ai';
import type { Seat } from '@rampart/protocol';
import { PHASES, type Action, type MatchEvent, type MatchState, type Phase } from '@rampart/sim';

import { Audio } from './audio.js';
import { Controls } from './controls.js';
import { bannersFor, type LifeLost } from './banners.js';
import { Hud, type IslandBanner } from './hud.js';
import { MatchAudio } from './matchAudio.js';
import { LocalMatch } from './localMatch.js';
import { ServerConnection } from './net/connection.js';
import { NetworkMatch } from './net/networkMatch.js';
import { Scene, createTheme } from './render/scene.js';

/**
 * Rampart client.
 *
 * A match is played either locally against stopgap opponents or against an
 * authoritative server. Both drive the same renderer, controls and HUD through one
 * session interface, so the netcode changes where the state comes from and nothing
 * about how the game is presented.
 */

const problems = validateConfigBundle(defaultConfigBundle);
if (problems.length > 0) {
  throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
}

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('missing #app');

/** Surfaces failures on the page: a renderer that throws otherwise looks like a black screen. */
function showError(source: string, detail: unknown): void {
  const message =
    detail instanceof Error ? `${detail.message}\n${detail.stack ?? ''}` : String(detail);
  const box = document.createElement('pre');
  box.className = 'crash';
  box.textContent = `${source}\n\n${message}`;
  app?.replaceChildren(box);
}
globalThis.addEventListener('error', (event) =>
  showError('Uncaught error', event.error ?? event.message),
);
globalThis.addEventListener('unhandledrejection', (event) =>
  showError('Unhandled rejection', event.reason),
);

/**
 * Sound, shared by the menu and every match.
 *
 * A browser will not start an audio context without a user gesture, so the first
 * click or keypress anywhere is what switches it on — the menu's own buttons are
 * usually that gesture, but `?autostart=1` skips the menu entirely and then the first
 * input in the match does it instead.
 */
const audio = new Audio(defaultConfigBundle.audio);
const unlock = (): void => audio.unlock();
globalThis.addEventListener('pointerdown', unlock, { capture: true });
globalThis.addEventListener('keydown', unlock, { capture: true });

globalThis.addEventListener('keydown', (event) => {
  if (event.key === 'm' || event.key === 'M') audio.setMuted(!audio.isMuted);
});

const params = new URLSearchParams(globalThis.location.search);
const preferredStyle: ArtStyle = ArtStyleSchema.catch(defaultArtConfig.style).parse(
  params.get('style'),
);
const timeScale = Math.max(1, Number(params.get('speed') ?? 1));

/** A player's colour as CSS, for the banners drawn over their island. */
function playerColourHex(player: number): string {
  const entry = defaultArtConfig.players[player % defaultArtConfig.players.length];
  return entry ? entry.base : '#ffffff';
}

/** What the render loop needs, whichever way the match is being played. */
interface Session {
  readonly state: MatchState;
  readonly humanPlayer: number;
  readonly tickFraction: number;
  readonly finished: boolean;
  advance(elapsedMs: number): MatchEvent[];
  submit(action: Action): void;
  /** Extra line for the HUD, such as latency. */
  status(): string;
}

// ------------------------------------------------------------------------ menu

interface Setup {
  /** One per seat: null for the person, otherwise the bot's skill. */
  seats: (Difficulty | null)[];
  seed: number;
  style: ArtStyle;
  name: string;
}

const DEFAULT_BOT: Difficulty = 'gunner';

/** Every seat count the rules allow, offered in the menu. */
const PLAYER_COUNTS = Array.from(
  { length: defaultConfigBundle.ruleset.players.max - defaultConfigBundle.ruleset.players.min + 1 },
  (_, i) => defaultConfigBundle.ruleset.players.min + i,
);
const DEFAULT_PLAYERS = 3;

function difficultyOptions(selected: string, includeHuman: boolean): string {
  const options = DIFFICULTIES.map(
    (d) => `<option value="${d}"${selected === d ? ' selected' : ''}>${label(d)}</option>`,
  );
  if (includeHuman) {
    options.unshift(`<option value="human"${selected === 'human' ? ' selected' : ''}>You</option>`);
  }
  return options.join('');
}

function label(difficulty: string): string {
  return difficulty.charAt(0).toUpperCase() + difficulty.slice(1);
}

function readCommon(): Omit<Setup, 'seats'> {
  return {
    seed: Number(document.querySelector<HTMLInputElement>('#seed')?.value ?? 1),
    style: ArtStyleSchema.catch(defaultArtConfig.style).parse(
      document.querySelector<HTMLSelectElement>('#style')?.value,
    ),
    name: document.querySelector<HTMLInputElement>('#name')?.value.trim() || 'Player',
  };
}

/** The seat list as the menu currently shows it. */
function readSeats(): (Difficulty | null)[] {
  return [...document.querySelectorAll<HTMLSelectElement>('.seat-select')].map((field) =>
    field.value === 'human' ? null : (field.value as Difficulty),
  );
}

function showMenu(): void {
  audio.music('music_menu');
  app!.innerHTML = `
    <div class="menu">
      <h1>Rampart</h1>
      <p>Shoot down their walls. Rebuild yours before the next barrage.
         Fail to seal a castle and you are out.</p>
      <label>Name <input id="name" type="text" maxlength="16" value="Player" /></label>
      <label>Seed <input id="seed" type="number" value="1" min="0" step="1" /></label>
      <label>Style
        <select id="style">
          <option value="pixel">Pixel art</option>
          <option value="flat">Minimal</option>
        </select>
      </label>
      <label>Players
        <select id="players">
          ${PLAYER_COUNTS.map(
            (n) => `<option value="${n}"${n === DEFAULT_PLAYERS ? ' selected' : ''}>${n}</option>`,
          ).join('')}
        </select>
      </label>
      <div id="seats" class="seats-config"></div>
      <button id="solo">Play offline</button>
      <div class="split">
        <button id="host">Host online</button>
        <span>or</span>
        <input id="code" type="text" maxlength="8" placeholder="room code" />
        <button id="join">Join</button>
      </div>
      <p class="note">Set every seat to a bot to watch a match instead of playing one.</p>
    </div>
  `;
  const styleField = document.querySelector<HTMLSelectElement>('#style');
  if (styleField) styleField.value = preferredStyle;

  const seatsRoot = document.querySelector<HTMLElement>('#seats');
  const playersField = document.querySelector<HTMLSelectElement>('#players');

  /** Redraws the seat rows, keeping choices where the count allows. */
  const drawSeats = (seats: (Difficulty | null)[]): void => {
    if (!seatsRoot) return;
    seatsRoot.innerHTML = seats
      .map((seat, i) => {
        const value = seat === null ? 'human' : seat;
        return `<label>Seat ${i + 1}
          <select class="seat-select" data-seat="${i}">${difficultyOptions(value, true)}</select>
        </label>`;
      })
      .join('');

    for (const field of seatsRoot.querySelectorAll<HTMLSelectElement>('.seat-select')) {
      field.addEventListener('change', () => {
        // Only one seat can be yours; taking a new one hands the old one to a bot.
        if (field.value === 'human') {
          for (const other of seatsRoot.querySelectorAll<HTMLSelectElement>('.seat-select')) {
            if (other !== field && other.value === 'human') other.value = DEFAULT_BOT;
          }
        }
      });
    }
  };

  const resize = (): void => {
    const count = Number(playersField?.value ?? 3);
    const existing = readSeats();
    const seats: (Difficulty | null)[] = Array.from(
      { length: count },
      (_, i) => existing[i] ?? DEFAULT_BOT,
    );
    if (!seats.includes(null)) seats[0] = null;
    drawSeats(seats);
  };
  playersField?.addEventListener('change', resize);
  drawSeats([null, DEFAULT_BOT, DEFAULT_BOT]);

  document.querySelector('#solo')?.addEventListener('click', () => {
    audio.play('select');
    const setup: Setup = { ...readCommon(), seats: readSeats() };
    void runSession(
      localSession(new LocalMatch({ seed: setup.seed, seats: setup.seats })),
      setup,
    ).catch((error: unknown) => showError('Failed to start match', error));
  });

  document.querySelector('#host')?.addEventListener('click', () => {
    audio.play('select');
    void startOnline({ ...readCommon(), seats: readSeats() }, null).catch((e: unknown) =>
      showError('Could not host', e),
    );
  });
  document.querySelector('#join')?.addEventListener('click', () => {
    audio.play('select');
    const code = document.querySelector<HTMLInputElement>('#code')?.value.trim() ?? '';
    if (code.length === 0) return;
    void startOnline({ ...readCommon(), seats: readSeats() }, code).catch((e: unknown) =>
      showError('Could not join', e),
    );
  });
}

function localSession(match: LocalMatch): Session {
  return {
    get state() {
      return match.state;
    },
    humanPlayer: match.humanPlayer,
    get tickFraction() {
      return match.tickFraction;
    },
    get finished() {
      return match.finished;
    },
    advance: (ms) => match.advance(ms * timeScale),
    submit: (action) => void match.submit(action),
    status: () => (match.humanPlayer < 0 ? 'watching' : ''),
  };
}

// ----------------------------------------------------------------------- lobby

const TOKEN_KEY = 'rampart.seat';

async function startOnline(setup: Setup, code: string | null): Promise<void> {
  const connection = new ServerConnection(ServerConnection.defaultUrl());
  const match = new NetworkMatch(connection);

  let seats: Seat[] = [];
  let bots: Difficulty[] = [];
  let playerCount = setup.seats.length;
  let hostId = -1;
  let roomCode = code ?? '';
  let started = false;

  connection.onMessage((message) => {
    match.receive(message);
    switch (message.type) {
      case 'welcome':
        roomCode = message.code;
        hostId = message.hostId;
        sessionStorage.setItem(TOKEN_KEY, `${message.code}:${message.token}`);
        break;
      case 'room':
        seats = message.seats;
        bots = [...message.bots];
        playerCount = message.playerCount;
        hostId = message.hostId;
        if (!message.started) renderLobby();
        break;
      case 'snapshot':
        if (!started) {
          started = true;
          void runSession(networkSession(match, connection), setup).catch((e: unknown) =>
            showError('Match failed', e),
          );
        }
        break;
      case 'error':
        showError(`Server refused: ${message.code}`, message.message);
        break;
      default:
        break;
    }
  });

  function renderLobby(): void {
    if (started) return;
    const isHost = match.humanPlayer === hostId;

    // One row per seat at the table: the people who have joined, then the bots that
    // will fill the rest. Only the host may change a bot.
    const rows = Array.from({ length: playerCount }, (_, i) => {
      const seat = seats.find((s) => s.playerId === i);
      if (seat) {
        const you = seat.playerId === match.humanPlayer ? ' class="you"' : '';
        const tags = [seat.playerId === hostId ? 'host' : '', seat.connected ? '' : 'away']
          .filter(Boolean)
          .map((t) => ` <em>${t}</em>`)
          .join('');
        return `<li${you}>${seat.name}${tags}</li>`;
      }
      const value = bots[i] ?? 'gunner';
      const control = isHost
        ? `<select class="bot-select" data-seat="${i}">${difficultyOptions(value, false)}</select>`
        : `<em>${label(value)}</em>`;
      return `<li class="bot">Bot ${i + 1} ${control}</li>`;
    }).join('');

    app!.innerHTML = `
      <div class="menu lobby">
        <h1>Room ${roomCode}</h1>
        <p>Share this code. Every seat nobody takes is played by a bot.</p>
        <ul class="seats">${rows}</ul>
        ${isHost ? '<button id="begin">Start match</button>' : '<p class="note">Waiting for the host to start.</p>'}
        <button id="leave" class="quiet">Leave</button>
      </div>
    `;

    for (const field of document.querySelectorAll<HTMLSelectElement>('.bot-select')) {
      field.addEventListener('change', () => {
        const next = [...bots];
        next[Number(field.dataset.seat)] = field.value as Difficulty;
        connection.send({ type: 'configure', bots: next });
      });
    }
    document
      .querySelector('#begin')
      ?.addEventListener('click', () => connection.send({ type: 'start' }));
    document.querySelector('#leave')?.addEventListener('click', () => {
      connection.close();
      showMenu();
    });
  }

  app!.innerHTML = `<div class="menu"><h1>Connecting</h1><p class="note">${ServerConnection.defaultUrl()}</p></div>`;
  await connection.connect();

  const stored = sessionStorage.getItem(TOKEN_KEY)?.split(':') ?? [];
  if (code === null) connection.createRoom(setup.name, setup.seats.length);
  else if (stored[0] === code.toUpperCase() && stored[1])
    connection.joinRoom(setup.name, code, stored[1]);
  else connection.joinRoom(setup.name, code);

  setInterval(() => connection.ping(), 2000);
}

function networkSession(match: NetworkMatch, connection: ServerConnection): Session {
  return {
    get state() {
      if (match.state === null) throw new Error('match has no state yet');
      return match.state;
    },
    get humanPlayer() {
      return match.humanPlayer;
    },
    get tickFraction() {
      return match.tickFraction;
    },
    get finished() {
      return match.finished;
    },
    advance: (ms) => match.advance(ms),
    submit: (action) => match.submit(action),
    status: () => {
      const parts = [`${connection.latencyMs}ms`];
      if (match.behind > 10) parts.push(`${match.behind} ticks behind`);
      if (match.desynced) parts.push('DESYNCED');
      if (match.lastRejection !== null) parts.push(match.lastRejection.replace(/_/g, ' '));
      return parts.join(' · ');
    },
  };
}

// ------------------------------------------------------------------ match loop

async function runSession(session: Session, setup: Setup): Promise<void> {
  app!.innerHTML = `<canvas id="stage"></canvas><div id="hud"></div><div id="banner"></div>`;
  const canvas = document.querySelector<HTMLCanvasElement>('#stage');
  const hudRoot = document.querySelector<HTMLElement>('#hud');
  const bannerRoot = document.querySelector<HTMLElement>('#banner');
  if (!canvas || !hudRoot || !bannerRoot) throw new Error('missing stage');

  const scene = new Scene();
  await scene.init(canvas, createTheme(setup.style, setup.seed));

  const hud = new Hud(hudRoot, bannerRoot);
  const matchAudio = new MatchAudio(audio, session.humanPlayer);

  /**
   * Middle of each player's island, for the banners that sit over them.
   *
   * The island, not the territory: by the time a "life lost" banner shows, the wipe has
   * already taken the territory away, so there would be nothing to anchor to. Islands
   * never move, so this is measured once.
   */
  const islandCentre = new Map<number, { x: number; y: number }>();
  {
    const sums = new Map<number, { x: number; y: number; n: number }>();
    const board = session.state;
    for (let i = 0; i < board.islandId.length; i++) {
      const island = board.islandId[i] as number;
      if (island === 0) continue;
      const x = i % board.width;
      const entry = sums.get(island) ?? { x: 0, y: 0, n: 0 };
      entry.x += x;
      entry.y += (i - x) / board.width;
      entry.n++;
      sums.set(island, entry);
    }
    for (const player of board.players) {
      const sum = sums.get(player.islandId);
      if (sum !== undefined) islandCentre.set(player.id, { x: sum.x / sum.n, y: sum.y / sum.n });
    }
  }

  /** Lives lost, and the tick each announcement stops being news. */
  const livesLost = new Map<number, LifeLost>();

  function drawIslandBanners(): void {
    const banners: IslandBanner[] = [];
    for (const banner of bannersFor(session.state, livesLost)) {
      const centre = islandCentre.get(banner.player);
      if (centre === undefined) continue;
      banners.push({
        ...banner,
        colour: playerColourHex(banner.player),
        ...scene.screenAt(centre.x, centre.y),
      });
    }
    hud.showIslandBanners(banners);
  }
  const controls = new Controls(
    canvas,
    scene,
    session.state,
    session.humanPlayer,
    (action) => {
      session.submit(action);
    },
    // Rotating and a refused placement are the two things the player does that the
    // simulation never hears about, so they are cued here rather than from an event.
    (cue) => audio.play(cue),
  );
  // Nobody at the keyboard in a watched match, so there is nothing to listen for.
  if (session.humanPlayer >= 0) controls.attach();

  const fit = (): void => {
    scene.resize(session.state, globalThis.innerWidth, globalThis.innerHeight);
    scene.drawTerrain(session.state);
    scene.drawTerritory(session.state);
    scene.drawStructures(session.state);
  };
  fit();
  globalThis.addEventListener('resize', fit);

  const restart = (event: KeyboardEvent): void => {
    // R returns to the menu once a match is over, whether it was played or watched.
    if ((event.key === 'r' || event.key === 'R') && session.finished) {
      cleanup();
      showMenu();
    }
  };
  globalThis.addEventListener('keydown', restart);

  let frame = 0;
  const cleanup = (): void => {
    cancelAnimationFrame(frame);
    controls.detach();
    globalThis.removeEventListener('resize', fit);
    globalThis.removeEventListener('keydown', restart);
    scene.app.destroy(true);
  };

  const bannerTicks = Math.ceil(
    (session.state.ruleset.phases.transitionBannerMs * session.state.ruleset.tickRateHz) / 1000,
  );
  let announcedAt: number | null = null;

  /** Fires the announcement once the end-of-phase pause is over, and once only. */
  function announceWhenDue(): void {
    const state = session.state;
    if (state.phase !== 'intermission' || state.pendingPhase === null) {
      announcedAt = null;
      return;
    }
    if (announcedAt === state.phaseEndTick) return;
    if (state.tick < state.phaseEndTick - bannerTicks) return;
    announcedAt = state.phaseEndTick;
    hud.announce(state.pendingPhase, state.ruleset.phases.transitionBannerMs);
  }

  function applyEvents(events: readonly MatchEvent[]): void {
    let structuresChanged = false;
    let territoryChanged = false;
    for (const event of events) {
      switch (event.kind) {
        case 'shot_impact':
          scene.noteImpact(event.x, event.y);
          if (event.destroyed.length > 0) structuresChanged = true;
          break;
        case 'castle_selected':
        case 'piece_placed':
          structuresChanged = true;
          territoryChanged = true;
          break;
        case 'cannon_placed':
          structuresChanged = true;
          break;
        case 'round_resolved':
        case 'player_eliminated':
          structuresChanged = true;
          territoryChanged = true;
          break;
        case 'player_continued': {
          // The sim lengthens the intermission by continueBannerMs for exactly this,
          // so the announcement has the board to itself. Held a little longer than the
          // pause, so it does not vanish the instant the next phase starts.
          const hold = Math.ceil(
            (session.state.ruleset.phases.continueBannerMs * 2 * session.state.ruleset.tickRateHz) /
              1000,
          );
          livesLost.set(event.player, {
            remaining: event.continuesRemaining,
            untilTick: event.tick + hold,
          });
          structuresChanged = true;
          territoryChanged = true;
          break;
        }
        case 'phase_changed':
          controls.resetRotation();
          territoryChanged = true;
          structuresChanged = true;
          break;
        default:
          break;
      }
    }
    if (structuresChanged) scene.drawStructures(session.state);
    if (territoryChanged) scene.drawTerritory(session.state);
  }

  let last = performance.now();
  const loop = (now: number): void => {
    const delta = now - last;
    last = now;

    const events = session.advance(delta);
    applyEvents(events);
    matchAudio.handle(events);
    matchAudio.frame(session.state);
    announceWhenDue();
    drawIslandBanners();
    hud.update(session.state, session.humanPlayer, session.status());

    scene.drawEffects(session.state, session.tickFraction, delta);
    scene.drawOverlay(session.state, controls.ghost(), session.humanPlayer);
    scene.render();

    frame = requestAnimationFrame(loop);
  };
  frame = requestAnimationFrame(loop);
}

if (params.get('autostart') === '1') {
  const count = Number(params.get('players') ?? 3);
  // ?watch=1 fills every seat with a bot, which is how a match is observed rather
  // than played.
  const watching = params.get('watch') === '1';
  const difficulty = (DIFFICULTIES as readonly string[]).includes(params.get('bots') ?? '')
    ? (params.get('bots') as Difficulty)
    : DEFAULT_BOT;
  const setup: Setup = {
    seats: Array.from({ length: count }, (_, i) => (i === 0 && !watching ? null : difficulty)),
    seed: Number(params.get('seed') ?? 1),
    style: preferredStyle,
    name: 'Player',
  };
  const match = new LocalMatch({ seed: setup.seed, seats: setup.seats });
  const phase = params.get('snapshot');
  if (phase !== null && PHASES.includes(phase as Phase)) match.fastForwardTo(phase as Phase);
  void runSession(localSession(match), setup).catch((error: unknown) =>
    showError('Failed to start match', error),
  );
} else {
  showMenu();
}
