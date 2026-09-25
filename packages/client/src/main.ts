import {
  ArtStyleSchema,
  applySettings,
  defaultArtConfig,
  defaultConfigBundle,
  defaultSettings,
  mergeSettings,
  validateConfigBundle,
  type ArtStyle,
  type MatchSettings,
  type SettingBounds,
} from '@rampart/config';
import { DIFFICULTIES, type Difficulty } from '@rampart/ai';
import type { Seat } from '@rampart/protocol';
import {
  PHASES,
  computeEnclosure,
  type Action,
  type MatchEvent,
  type MatchState,
  type Phase,
} from '@rampart/sim';

import { Audio } from './audio.js';
import { Controls } from './controls.js';
import { bannersFor, type LifeLost, type PointsGained } from './banners.js';
import { playerCssColour } from './colours.js';
import { lobbyMarkup, rangeOptions } from './lobby.js';
import { Hud, type IslandBanner } from './hud.js';
import { MatchAudio } from './matchAudio.js';
import { LocalMatch } from './localMatch.js';
import { announcementLines } from './scores.js';
import { buildHints, type BuildHints } from './hints.js';
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
  /** The host's choices, offline as online, so a round limit can be felt out alone. */
  settings: MatchSettings;
}

const SETTING_BOUNDS = defaultConfigBundle.server.lobbySettings;
const DEFAULT_SETTINGS = defaultSettings(defaultConfigBundle.ruleset, SETTING_BOUNDS);

/** An offline match on the default rules with the menu's settings over them. */
function localMatchFor(setup: Setup): LocalMatch {
  return new LocalMatch({
    seed: setup.seed,
    seats: setup.seats,
    ruleset: applySettings(defaultConfigBundle.ruleset, setup.settings),
  });
}

const DEFAULT_BOT: Difficulty = 'gunner';

/** Height of the HUD's top bar — the phase, timer and roster — kept clear of the board. */
const HUD_BAR_PX = 64;

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
    settings: {
      maxRounds: Number(
        document.querySelector<HTMLSelectElement>('#max-rounds')?.value ??
          DEFAULT_SETTINGS.maxRounds,
      ),
    },
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
      <label>Rounds
        <select id="max-rounds">${rangeOptions(
          SETTING_BOUNDS.maxRounds.min,
          SETTING_BOUNDS.maxRounds.max,
          DEFAULT_SETTINGS.maxRounds,
        )}</select>
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
    void runSession(localSession(localMatchFor(setup)), setup).catch((error: unknown) =>
      showError('Failed to start match', error),
    );
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
  let settings: MatchSettings = setup.settings;
  let settingBounds: SettingBounds = SETTING_BOUNDS;
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
        // A new room opens on the server's defaults; the host carries the menu's
        // choice across rather than having to make it twice.
        if (code === null) connection.send({ type: 'configure', settings: setup.settings });
        sessionStorage.setItem(TOKEN_KEY, `${message.code}:${message.token}`);
        break;
      case 'room':
        seats = message.seats;
        bots = [...message.bots];
        settings = message.settings;
        settingBounds = message.settingBounds;
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
    app!.innerHTML = lobbyMarkup({
      code: roomCode,
      playerCount,
      hostId,
      humanPlayer: match.humanPlayer,
      seats,
      bots,
      settings,
      settingBounds,
    });

    const rounds = document.querySelector<HTMLSelectElement>('#max-rounds');
    rounds?.addEventListener('change', () => {
      audio.play('select');
      connection.send({ type: 'configure', settings: { maxRounds: Number(rounds.value) } });
    });

    for (const field of document.querySelectorAll<HTMLSelectElement>('.bot-select')) {
      field.addEventListener('change', () => {
        audio.play('select');
        const next = [...bots];
        next[Number(field.dataset.seat)] = field.value as Difficulty;
        connection.send({ type: 'configure', bots: next });
      });
    }

    // Copying beats reading a code aloud, and the fallback matters: the clipboard API
    // is unavailable over plain http on anything but localhost, which is exactly how
    // somebody will first try this on a home network.
    const copy = document.querySelector<HTMLButtonElement>('#copy-code');
    copy?.addEventListener('click', () => {
      audio.play('select');
      void navigator.clipboard
        ?.writeText(roomCode)
        .then(() => {
          copy.textContent = 'Copied';
          setTimeout(() => (copy.textContent = 'Copy'), 1200);
        })
        .catch(() => {
          // Select it instead, so it can still be copied by hand.
          const node = document.querySelector('#room-code');
          if (node) globalThis.getSelection()?.selectAllChildren(node);
          copy.textContent = 'Select and copy';
        });
    });

    document.querySelector('#begin')?.addEventListener('click', () => {
      audio.play('select');
      connection.send({ type: 'start' });
    });
    document.querySelector('#leave')?.addEventListener('click', () => {
      audio.play('select');
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
  const gained = new Map<number, PointsGained>();
  /** What the board points out to a player building; see `hints.ts`. */
  let hints: BuildHints = { leak: [], unsealed: [] };

  function drawIslandBanners(): void {
    const banners: IslandBanner[] = [];
    for (const banner of bannersFor(session.state, livesLost, gained)) {
      const centre = islandCentre.get(banner.player);
      if (centre === undefined) continue;
      banners.push({
        ...banner,
        colour: playerCssColour(banner.player),
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
    scene.resize(session.state, globalThis.innerWidth, globalThis.innerHeight, HUD_BAR_PX);
    scene.drawTerrain(session.state);
    scene.drawTerritory(session.state, computeEnclosure(session.state).territory);
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
  /** Set by a resolution, so the announcement after it carries the standings. */
  let resolvedSinceAnnounce = false;

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
    hud.announce(
      state.pendingPhase,
      state.ruleset.phases.transitionBannerMs,
      announcementLines(state, resolvedSinceAnnounce),
    );
    resolvedSinceAnnounce = false;
  }

  /** The board's enclosure as it stands, for display; see `Scene.drawTerritory`. */
  let live = computeEnclosure(session.state);

  function applyEvents(events: readonly MatchEvent[]): void {
    let structuresChanged = false;
    let territoryChanged = false;
    for (const event of events) {
      switch (event.kind) {
        case 'shot_impact': {
          const { width, islandId } = session.state;
          const debris = event.destroyed.map((i) => ({
            x: i % width,
            y: Math.floor(i / width),
            owner: (islandId[i] as number) - 1,
          }));
          scene.noteImpact(event.x, event.y, debris);
          // Only for your own wall: shots land all over the map, all the time.
          const human = session.humanPlayer;
          if (human >= 0 && debris.some((d) => d.owner === human)) scene.shake();
          if (event.destroyed.length > 0) structuresChanged = true;
          break;
        }
        case 'shot_fired':
          scene.noteShot(event.shot);
          break;
        case 'castle_selected':
        case 'piece_placed':
          structuresChanged = true;
          territoryChanged = true;
          break;
        case 'cannon_placed':
          structuresChanged = true;
          break;
        case 'round_resolved': {
          // Shown over each island for as long as a lost life would be.
          const hold = Math.ceil(
            (session.state.ruleset.phases.continueBannerMs * 2 * session.state.ruleset.tickRateHz) /
              1000,
          );
          for (const result of event.results) {
            gained.set(result.player, {
              amount: result.territoryPoints + result.damagePoints,
              untilTick: event.tick + hold,
            });
          }
          resolvedSinceAnnounce = true;
          structuresChanged = true;
          territoryChanged = true;
          break;
        }
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
    if (territoryChanged || structuresChanged) {
      live = computeEnclosure(session.state);
      scene.drawTerritory(session.state, live.territory);
      hints = buildHints(session.state, session.humanPlayer, live);
    }
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
    hud.update(session.state, session.humanPlayer, session.status(), live.enclosedCastlesByPlayer);

    scene.drawEffects(session.state, session.tickFraction, delta, live.castleEnclosed);
    scene.drawOverlay(session.state, { ...controls.ghost(), ...hints }, session.humanPlayer);
    scene.render();

    frame = requestAnimationFrame(loop);
  };
  frame = requestAnimationFrame(loop);
}

/** `?rounds=N`, ignored when it is outside what a host could choose. */
function settingsFromParams(): MatchSettings {
  const rounds = Number(params.get('rounds') ?? DEFAULT_SETTINGS.maxRounds);
  return mergeSettings(DEFAULT_SETTINGS, { maxRounds: rounds }, SETTING_BOUNDS) ?? DEFAULT_SETTINGS;
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
    settings: settingsFromParams(),
  };
  const match = localMatchFor(setup);
  const phase = params.get('snapshot');
  // &round=N stops at that phase in round N or later, for looking at a match deep in.
  if (phase !== null && PHASES.includes(phase as Phase)) {
    match.fastForwardTo(
      phase as Phase,
      Number(params.get('round') ?? 0),
      params.get('idle') === '1',
    );
  }
  void runSession(localSession(match), setup).catch((error: unknown) =>
    showError('Failed to start match', error),
  );
} else if (params.get('host') !== null || params.get('join') !== null) {
  // The online lobby had no way in except clicking through the menu, which meant it
  // could not be looked at the way `?autostart=1` lets the offline game be looked at —
  // and it went un-inspected at more than four seats for exactly that long.
  const joining = params.get('join');
  const setup: Setup = {
    seats: Array.from({ length: Number(params.get('host') ?? 2) }, (_, i) =>
      i === 0 ? null : DEFAULT_BOT,
    ),
    seed: Number(params.get('seed') ?? 1),
    style: preferredStyle,
    name: params.get('name') ?? 'Player',
    settings: settingsFromParams(),
  };
  void startOnline(setup, joining).catch((error: unknown) =>
    showError(joining !== null ? 'Could not join' : 'Could not host', error),
  );
} else {
  showMenu();
}
