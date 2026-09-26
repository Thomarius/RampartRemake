import {
  ArtStyleSchema,
  applySettings,
  defaultArtConfig,
  defaultConfigBundle,
  defaultSettings,
  defaultTeams,
  mergeSettings,
  reshapeTable,
  validateConfigBundle,
  type ArtStyle,
  type ArtStyles,
  type MatchSettings,
  type Table,
} from '@rampart/config';
import { DIFFICULTIES, type Difficulty } from '@rampart/ai';
import {
  PHASES,
  computeEnclosure,
  owesCastleChoice,
  type Action,
  type MatchEvent,
  type MatchState,
  type Phase,
} from '@rampart/sim';

import { Audio } from './audio.js';
import { Controls, inputMode, readyCannons } from './controls.js';
import { bannersFor, type LifeLost, type PointsGained } from './banners.js';
import { matchPalette, playerCssColour, useMatchPalette } from './colours.js';
import { lobbyMarkup, type LobbyView } from './lobby.js';
import { Hud, type IslandBanner } from './hud.js';
import { MatchAudio } from './matchAudio.js';
import { LocalMatch } from './localMatch.js';
import { announcementLines, isTeamMatch, teamLetter } from './scores.js';
import { buildHints, type BuildHints } from './hints.js';
import { timerSpot } from './timerSpot.js';
import {
  floodFrom,
  floodOver,
  sealGlow,
  territoryDuring,
  type Flood,
  type SealGlow,
} from './seal.js';
import {
  bannerProgress,
  boardWithStanding,
  looksAround,
  stillStanding,
  type SweptWall,
} from './transition.js';
import { ServerConnection } from './net/connection.js';
import { NetworkMatch } from './net/networkMatch.js';
import type { ServerMessage } from '@rampart/protocol';
import { Scene, createTheme, type Ghost } from './render/scene.js';

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

/** Where the menu remembers the two looks, so they survive a reload. */
const STYLES_KEY = 'rampart.styles';

function storedStyles(): Partial<ArtStyles> {
  try {
    const raw: unknown = JSON.parse(globalThis.localStorage?.getItem(STYLES_KEY) ?? '{}');
    const stored = raw as Record<string, unknown>;
    return {
      ...(ArtStyleSchema.safeParse(stored.build).success
        ? { build: stored.build as ArtStyle }
        : {}),
      ...(ArtStyleSchema.safeParse(stored.combat).success
        ? { combat: stored.combat as ArtStyle }
        : {}),
    };
  } catch {
    return {};
  }
}

/**
 * The look for building and the look for combat. `?style=` sets both, which is what the
 * screenshot script and older links mean by it; `?buildStyle=` and `?combatStyle=` set
 * one each. Then what the menu last saved, then the configured default pair.
 */
function preferredStyles(): ArtStyles {
  const both = ArtStyleSchema.safeParse(params.get('style'));
  const build = ArtStyleSchema.safeParse(params.get('buildStyle'));
  const combat = ArtStyleSchema.safeParse(params.get('combatStyle'));
  const stored = storedStyles();
  const fallback = defaultArtConfig.styles;
  return {
    build: build.data ?? both.data ?? stored.build ?? fallback.build,
    combat: combat.data ?? both.data ?? stored.combat ?? fallback.combat,
  };
}
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
  styles: ArtStyles;
  name: string;
  /** The host's choices, offline as online, so a round limit can be felt out alone. */
  settings: MatchSettings;
  /** Each seat's team, by seat. Omitted, free-for-all. */
  teams?: readonly number[];
}

const SETTING_BOUNDS = defaultConfigBundle.server.lobbySettings;
const DEFAULT_SETTINGS = defaultSettings(defaultConfigBundle.ruleset, SETTING_BOUNDS);

/** An offline match on the default rules with the menu's settings over them. */
function localMatchFor(setup: Setup): LocalMatch {
  return new LocalMatch({
    seed: setup.seed,
    seats: setup.seats,
    ...(setup.teams === undefined ? {} : { teams: setup.teams }),
    ruleset: applySettings(defaultConfigBundle.ruleset, setup.settings),
  });
}

const DEFAULT_BOT: Difficulty = 'gunner';

/** Height of the HUD's top bar — the phase, timer and roster — kept clear of the board. */
const HUD_BAR_PX = 64;

const DEFAULT_PLAYERS = 3;

/** What the menu gathers before a table is set: who you are and how it looks. */
interface Common {
  name: string;
  seed: number;
  styles: ArtStyles;
}

/** The menu's two style choices, saved for next time as they are read. */
function readStyles(): ArtStyles {
  const fallback = preferredStyles();
  const styles: ArtStyles = {
    build: ArtStyleSchema.catch(fallback.build).parse(
      document.querySelector<HTMLSelectElement>('#build-style')?.value,
    ),
    combat: ArtStyleSchema.catch(fallback.combat).parse(
      document.querySelector<HTMLSelectElement>('#combat-style')?.value,
    ),
  };
  try {
    globalThis.localStorage?.setItem(STYLES_KEY, JSON.stringify(styles));
  } catch {
    // Storage refused, as in some private windows: the choice holds for this match only.
  }
  return styles;
}

/** Names for the styles, as the menu offers them. */
const STYLE_NAMES: Record<ArtStyle, string> = { flat: 'Minimal', pixel: 'Pixel art' };

function styleOptions(): string {
  return ArtStyleSchema.options
    .map((style) => `<option value="${style}">${STYLE_NAMES[style]}</option>`)
    .join('');
}

function readCommon(): Common {
  return {
    seed: Number(document.querySelector<HTMLInputElement>('#seed')?.value ?? 1),
    styles: readStyles(),
    name: document.querySelector<HTMLInputElement>('#name')?.value.trim() || 'Player',
  };
}

/**
 * The menu: only who you are and how the game looks. Everything about the table —
 * players, teams, bots, rounds — is set in the lobby, which is one screen whether or
 * not a server is there.
 */
function showMenu(): void {
  audio.music('music_menu');
  app!.innerHTML = `
    <div class="menu">
      <h1>Rampart</h1>
      <p>Shoot down their walls. Rebuild yours before the next barrage.
         Fail to seal a castle and you lose a life.</p>
      <label>Name <input id="name" type="text" maxlength="16" value="Player" /></label>
      <label>Seed <input id="seed" type="number" value="1" min="0" step="1" /></label>
      <label>Building look <select id="build-style">${styleOptions()}</select></label>
      <label>Combat look <select id="combat-style">${styleOptions()}</select></label>
      <button id="play">Play</button>
      <div class="split">
        <input id="code" type="text" maxlength="8" placeholder="room code" />
        <button id="join">Join</button>
      </div>
      <p class="note">Play sets a table others can join with its code. If nobody does,
        the match runs on this computer.</p>
    </div>
  `;
  // The banners either side of combat swap one look for the other as they cross the
  // board, as the original did; the same style for both switches nothing.
  const styles = preferredStyles();
  const buildField = document.querySelector<HTMLSelectElement>('#build-style');
  if (buildField) buildField.value = styles.build;
  const combatField = document.querySelector<HTMLSelectElement>('#combat-style');
  if (combatField) combatField.value = styles.combat;

  document.querySelector('#play')?.addEventListener('click', () => {
    audio.play('select');
    void openLobby(readCommon(), null).catch((e: unknown) =>
      showError('Could not open a table', e),
    );
  });
  document.querySelector('#join')?.addEventListener('click', () => {
    audio.play('select');
    const code = document.querySelector<HTMLInputElement>('#code')?.value.trim() ?? '';
    if (code.length === 0) return;
    void openLobby(readCommon(), code).catch((e: unknown) => showError('Could not join', e));
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

/** How long to wait for a server before setting the table locally instead. */
const SERVER_WAIT_MS = 2000;

/** What the lobby's controls do, whichever backend is behind them. */
interface LobbyHandlers {
  table(change: { settings?: MatchSettings; playerCount?: number; teams?: number[] }): void;
  bot(seat: number, tier: Difficulty): void;
  start(): void;
  watch(): void;
}

/** Draws the lobby and wires its controls to whichever backend holds the table. */
function drawLobby(view: LobbyView, on: LobbyHandlers): void {
  app!.innerHTML = lobbyMarkup(view);
  const number = (id: string, apply: (n: number) => void): void => {
    const field = document.querySelector<HTMLSelectElement>(id);
    field?.addEventListener('change', () => {
      audio.play('select');
      apply(Number(field.value));
    });
  };
  number('#team-size', (teamSize) => on.table({ settings: { ...view.settings, teamSize } }));
  number('#player-count', (playerCount) => on.table({ playerCount }));
  number('#max-rounds', (maxRounds) => on.table({ settings: { ...view.settings, maxRounds } }));
  for (const field of document.querySelectorAll<HTMLSelectElement>('.bot-select')) {
    field.addEventListener('change', () => {
      audio.play('select');
      on.bot(Number(field.dataset.seat), field.value as Difficulty);
    });
  }
  for (const field of document.querySelectorAll<HTMLSelectElement>('.team-select')) {
    field.addEventListener('change', () => {
      audio.play('select');
      const teams = [...view.teams];
      teams[Number(field.dataset.seat)] = Number(field.value);
      on.table({ teams });
    });
  }

  // Copying beats reading a code aloud, and the fallback matters: the clipboard API
  // is unavailable over plain http on anything but localhost, which is exactly how
  // somebody will first try this on a home network.
  const copy = document.querySelector<HTMLButtonElement>('#copy-code');
  copy?.addEventListener('click', () => {
    audio.play('select');
    void navigator.clipboard
      ?.writeText(view.code ?? '')
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
    on.start();
  });
  document.querySelector('#watch')?.addEventListener('click', () => {
    audio.play('select');
    on.watch();
  });
}

/** The table as the local lobby holds it, and as a room reports it. */
interface TableState extends Table {
  bots: Difficulty[];
}

/**
 * Plays a table on this computer: the person in seat 0 unless watching, bots in the
 * rest, islands shuffled among the seats exactly as the server would.
 */
function playLocally(common: Common, table: TableState, watching: boolean): void {
  const setup: Setup = {
    ...common,
    seats: table.bots
      .slice(0, table.playerCount)
      .map((tier, seat) => (seat === 0 && !watching ? null : tier)),
    settings: table.settings,
    teams: table.teams,
  };
  void runSession(localSession(localMatchFor(setup)), setup).catch((error: unknown) =>
    showError('Failed to start match', error),
  );
}

/**
 * Opens the lobby: a room if a server answers, a table on this computer if not.
 *
 * "Answers" means a welcome within the wait, not merely an open socket: under the dev
 * server the socket's address is the dev server's own, which may accept the connection
 * and then say nothing. Solo play never waits on a network for longer than that. Joining
 * by code does need the server, so that fails plainly rather than dropping the player at
 * a table of their own.
 */
async function openLobby(
  common: Common,
  code: string | null,
  playerCount = DEFAULT_PLAYERS,
): Promise<void> {
  app!.innerHTML = `<div class="menu"><h1>Setting the table</h1><p class="note">Looking for a server…</p></div>`;
  const connection = new ServerConnection(ServerConnection.defaultUrl());
  const answered = new Promise<ServerMessage | null>((resolve) => {
    connection.onMessage((message) => {
      if (message.type === 'welcome' || message.type === 'error') resolve(message);
    });
    setTimeout(() => resolve(null), SERVER_WAIT_MS);
  });
  connection.connect().catch(() => undefined);

  const stored = sessionStorage.getItem(TOKEN_KEY)?.split(':') ?? [];
  if (code === null) connection.createRoom(common.name, playerCount);
  else if (stored[0] === code.toUpperCase() && stored[1])
    connection.joinRoom(common.name, code, stored[1]);
  else connection.joinRoom(common.name, code);

  const first = await answered;
  if (first?.type === 'welcome') {
    roomLobby(common, connection, code, first);
    return;
  }
  connection.close();
  if (first?.type === 'error') {
    showError(`Server refused: ${first.code}`, first.message);
    return;
  }
  if (code !== null) {
    showError('Could not join', `no server answered at ${ServerConnection.defaultUrl()}`);
    return;
  }
  localLobby(common, playerCount);
}

/** The lobby with no server: the table lives here, under the same rules as a room's. */
function localLobby(common: Common, playerCount: number): void {
  const limits = defaultConfigBundle.ruleset.players;
  const start = reshapeTable(
    { settings: DEFAULT_SETTINGS, playerCount: limits.min, teams: defaultTeams(limits.min, 1) },
    { playerCount },
    limits,
    1,
  );
  let table: TableState = { ...start, bots: Array.from({ length: limits.max }, () => DEFAULT_BOT) };

  const redraw = (): void =>
    drawLobby(
      {
        code: null,
        playerCount: table.playerCount,
        hostId: 0,
        humanPlayer: 0,
        seats: [{ playerId: 0, name: common.name, isBot: false, connected: true, ready: true }],
        bots: table.bots.slice(0, table.playerCount),
        settings: table.settings,
        settingBounds: SETTING_BOUNDS,
        teams: table.teams,
        playerLimits: limits,
      },
      {
        table: (change) => {
          table = { ...table, ...reshapeTable(table, change, limits, 1) };
          redraw();
        },
        bot: (seat, tier) => {
          table.bots[seat] = tier;
          redraw();
        },
        start: () => playLocally(common, table, false),
        watch: () => playLocally(common, table, true),
      },
    );
  redraw();
  document.querySelector('#leave')?.addEventListener('click', () => showMenu());
}

/**
 * The lobby as a room on the server. At the start, a table nobody else has joined is
 * played locally from the room's settings, and the room is left: there is nobody to
 * share a server with.
 */
function roomLobby(
  common: Common,
  connection: ServerConnection,
  code: string | null,
  welcome: Extract<ServerMessage, { type: 'welcome' }>,
): void {
  const match = new NetworkMatch(connection);
  let view: LobbyView | null = null;
  let roomCode = code ?? '';
  let hostId = -1;
  let started = false;

  const tableOf = (v: LobbyView): TableState => ({
    settings: v.settings,
    playerCount: v.playerCount,
    teams: [...v.teams],
    bots: [...v.bots],
  });

  const render = (): void => {
    if (started || view === null) return;
    const current = view;
    drawLobby(current, {
      table: (change) => connection.send({ type: 'configure', ...change }),
      bot: (seat, tier) => {
        const bots = [...current.bots];
        bots[seat] = tier;
        connection.send({ type: 'configure', bots });
      },
      start: () => {
        if (current.seats.length > 1) {
          connection.send({ type: 'start' });
          return;
        }
        started = true;
        connection.close();
        playLocally(common, tableOf(current), false);
      },
      watch: () => {
        started = true;
        connection.close();
        playLocally(common, tableOf(current), true);
      },
    });
    document.querySelector('#leave')?.addEventListener('click', () => {
      audio.play('select');
      started = true;
      connection.close();
      showMenu();
    });
  };

  connection.onMessage((message) => {
    match.receive(message);
    switch (message.type) {
      case 'welcome':
        roomCode = message.code;
        hostId = message.hostId;
        sessionStorage.setItem(TOKEN_KEY, `${message.code}:${message.token}`);
        break;
      case 'room':
        hostId = message.hostId;
        view = {
          code: roomCode,
          playerCount: message.playerCount,
          hostId,
          humanPlayer: match.humanPlayer,
          seats: message.seats,
          bots: [...message.bots],
          settings: message.settings,
          settingBounds: message.settingBounds,
          teams: [...message.teams],
          playerLimits: message.playerLimits,
        };
        if (!message.started) render();
        break;
      case 'snapshot':
        if (!started) {
          started = true;
          const setup: Setup = { ...common, seats: [], settings: DEFAULT_SETTINGS };
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

  // The welcome that decided there was a server arrived before this listener did.
  match.receive(welcome);
  roomCode = welcome.code;
  hostId = welcome.hostId;
  sessionStorage.setItem(TOKEN_KEY, `${welcome.code}:${welcome.token}`);

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
  // Colours for this match: families by team in a team match, distinct otherwise.
  const palette = matchPalette(defaultConfigBundle.art, session.state);
  useMatchPalette(palette);
  // One theme when both looks are the same style, so the wipe has nothing to change.
  const buildTheme = createTheme(setup.styles.build, setup.seed);
  const combatTheme =
    setup.styles.combat === setup.styles.build
      ? buildTheme
      : createTheme(setup.styles.combat, setup.seed);
  await scene.init(
    canvas,
    { build: buildTheme, combat: combatTheme },
    { ...defaultConfigBundle.art, players: palette },
  );

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
  let hints: BuildHints = { unsealed: [] };

  // The top left of each island, for its team's letter; terrain never changes. Not the
  // top middle, which is where the big timer sits on the islands in the middle column.
  const islandTops = new Map<number, { x: number; y: number }>();
  if (isTeamMatch(session.state)) {
    const { width, islandId } = session.state;
    for (const player of session.state.players) {
      let top = Number.POSITIVE_INFINITY;
      let left = Number.POSITIVE_INFINITY;
      let right = -1;
      for (let i = 0; i < islandId.length; i++) {
        if (islandId[i] !== player.islandId) continue;
        const x = i % width;
        top = Math.min(top, (i - x) / width);
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
      if (right >= 0) islandTops.set(player.id, { x: left + 3, y: top });
    }
  }

  function drawIslandBanners(): void {
    hud.showTeamTags(
      [...islandTops].map(([player, at]) => ({
        player,
        text: `Team ${teamLetter(session.state.players[player]?.team ?? 0)}`,
        colour: playerCssColour(player),
        ...scene.screenAt(at.x, at.y - 0.3),
      })),
    );
    const banners: IslandBanner[] = [];
    for (const banner of bannersFor(session.state, livesLost, gained)) {
      const centre = islandCentre.get(banner.player);
      if (centre === undefined) continue;
      banners.push({
        ...banner,
        holdMs: defaultConfigBundle.art.hud.pointsBannerMs,
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

  /**
   * Walls the sim swept at the last resolution that the banner has not yet reached; see
   * `transition.ts`. Owners are read from the board as last drawn, because the sweep
   * has already zeroed them in the state.
   */
  let swept: SweptWall[] = [];
  /** The owner layer as last drawn, for exactly that. */
  let drawnOwner = session.state.owner.slice();

  /** Walls, castles and cannons, with any swept wall still standing put back. */
  function drawBoard(): void {
    const board = boardWithStanding(session.state, swept);
    scene.drawStructures({ ...session.state, ...board });
    drawnOwner = board.owner.slice();
  }

  const fit = (): void => {
    scene.resize(session.state, globalThis.innerWidth, globalThis.innerHeight, HUD_BAR_PX);
    scene.drawTerrain(session.state);
    scene.drawTerritory(session.state, computeEnclosure(session.state).territory);
    drawBoard();
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

  /** The intermission whose banner is showing, by the tick it ends on. */
  let announcedAt: number | null = null;
  /** Set by a resolution, so the announcement after it carries the standings. */
  let resolvedSinceAnnounce = false;

  /**
   * The announcement, and what it does to the board as it crosses: the look beneath
   * changes at its line, and swept walls go as it reaches them. Every frame, from the
   * simulation clock, so the two can never part company.
   */
  function drawTransition(): void {
    const state = session.state;
    const progress = bannerProgress(state, session.tickFraction);
    const { before, after } = looksAround(state);
    let lineY: number | null = null;
    if (progress === null) {
      hud.clearAnnouncement();
      announcedAt = null;
    } else {
      if (announcedAt !== state.phaseEndTick) {
        announcedAt = state.phaseEndTick;
        // After a continue the cannon phase opens with a castle to choose, and the
        // announcement should say so rather than tell them to place guns they cannot.
        const human = state.players[session.humanPlayer];
        const choosing =
          state.pendingPhase === 'cannon_place' && human !== undefined && owesCastleChoice(human);
        hud.announce(
          choosing ? 'castle_select' : (state.pendingPhase ?? 'combat'),
          announcementLines(state, resolvedSinceAnnounce),
        );
        resolvedSinceAnnounce = false;
      }
      lineY = hud.placeAnnouncement(progress);
    }
    scene.showLooks(
      lineY === null
        ? { from: before, to: before, lineY: null }
        : { from: before, to: after, lineY },
    );
    sweepUnderBanner(lineY);
  }

  /** Takes away each swept wall as the banner's line passes it. */
  function sweepUnderBanner(lineY: number | null): void {
    if (swept.length === 0) return;
    // Any banner will do — normally "Place cannons", but "Fire!" when nobody had guns
    // to place — and once the intermission is over, whatever is left goes.
    const over = session.state.phase !== 'intermission';
    const lineRow = over
      ? Number.POSITIVE_INFINITY
      : lineY === null
        ? Number.NEGATIVE_INFINITY
        : scene.rowAt(lineY);
    const standing = stillStanding(swept, session.state.width, lineRow);
    if (standing.length === swept.length) return;
    const width = session.state.width;
    const kept = new Set(standing.map((wall) => wall.index));
    for (const wall of swept) {
      if (kept.has(wall.index)) continue;
      const x = wall.index % width;
      scene.noteCrumble({ x, y: (wall.index - x) / width, owner: wall.owner - 1 });
    }
    swept = standing;
    drawBoard();
  }

  /** Open water near the middle, for the big timer. Terrain is fixed, so asked once. */
  const bigTimerAt = timerSpot(session.state);
  const TIMED: readonly Phase[] = ['castle_select', 'cannon_place', 'build', 'combat'];

  /** The big timer, and the ready count beside the aiming cursor. */
  function drawCounters(ghost: Ghost): void {
    const state = session.state;
    if (bigTimerAt !== null && TIMED.includes(state.phase)) {
      const centre = scene.screenAt(bigTimerAt.x - 0.5, bigTimerAt.y - 0.5);
      const edge = scene.screenAt(bigTimerAt.x - 0.5 + bigTimerAt.size, bigTimerAt.y - 0.5);
      const seconds = Math.max(
        0,
        Math.ceil((state.phaseEndTick - state.tick) / state.ruleset.tickRateHz),
      );
      hud.showBigTimer({ ...centre, sizePx: edge.x - centre.x }, seconds);
    } else {
      hud.showBigTimer(null, 0);
    }
    // Beside the cursor, the number that decides the next click: guns ready when
    // aiming, guns still to place when placing them.
    const mode = inputMode(state, session.humanPlayer);
    const count =
      mode === 'fire' || mode === 'aim'
        ? readyCannons(state, session.humanPlayer)
        : mode === 'cannon'
          ? (state.players[session.humanPlayer]?.cannonsToPlace ?? 0)
          : null;
    hud.showReadyCount(
      ghost.tile !== null && count !== null
        ? scene.screenAt(ghost.tile.x + 1.4, ghost.tile.y - 1.1)
        : null,
      count ?? 0,
    );
  }

  /** The board's enclosure as it stands, for display; see `Scene.drawTerritory`. */
  let live = computeEnclosure(session.state);

  /**
   * Newly sealed ground flooding out from its castle; see `seal.ts`. Started whenever
   * the enclosure gains territory — a breach closed, a castle chosen, a loop widened —
   * and drawn in both looks, since it shows exactly what was sealed.
   */
  let floods: Flood[] = [];
  const { sealFloodTilesPerSecond, sealGlowTiles } = defaultConfigBundle.art.effects;

  /** Territory as it stands, less what the floods have not reached yet. */
  function drawFloodedTerritory(now: number): void {
    scene.drawTerritory(
      session.state,
      territoryDuring(live.territory, floods, now, sealFloodTilesPerSecond),
    );
  }

  /** Advances the floods by a frame, and returns the glow at their fronts. */
  function advanceFloods(): SealGlow[] {
    if (floods.length === 0) return [];
    const now = performance.now();
    floods = floods.filter(
      (flood) => !floodOver(flood, now, sealFloodTilesPerSecond, sealGlowTiles),
    );
    drawFloodedTerritory(now);
    return sealGlow(floods, now, session.state.width, sealFloodTilesPerSecond, sealGlowTiles);
  }

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
        case 'piece_placed': {
          // Whose island it went on, which is not always the placer's in a team match.
          const { width, owner } = session.state;
          const cells = event.cells.map((i) => ({ x: i % width, y: Math.floor(i / width) }));
          const first = event.cells[0];
          if (first !== undefined) scene.noteLanding(cells, (owner[first] as number) - 1);
          structuresChanged = true;
          territoryChanged = true;
          break;
        }
        case 'castle_selected':
          structuresChanged = true;
          territoryChanged = true;
          break;
        case 'cannon_placed':
          structuresChanged = true;
          break;
        case 'round_resolved': {
          const hold = Math.ceil(
            (defaultConfigBundle.art.hud.pointsBannerMs * session.state.ruleset.tickRateHz) / 1000,
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
        case 'walls_swept':
          // Drawn away by the next banner rather than now; see `sweepUnderBanner`. A
          // block placed in this same step was never drawn, so its island says whose.
          swept = event.tiles.map((index) => ({
            index,
            owner: (drawnOwner[index] as number) || (session.state.islandId[index] as number),
          }));
          structuresChanged = true;
          break;
        case 'phase_changed':
          controls.resetRotation();
          territoryChanged = true;
          structuresChanged = true;
          break;
        default:
          break;
      }
    }
    if (structuresChanged) drawBoard();
    if (territoryChanged || structuresChanged) {
      const before = live.territory;
      live = computeEnclosure(session.state);
      const now = performance.now();
      const flood = floodFrom(
        before,
        live.territory,
        session.state.width,
        session.state.castles,
        now,
      );
      if (flood !== null) floods.push(flood);
      drawFloodedTerritory(now);
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
    drawTransition();
    drawIslandBanners();
    hud.update(session.state, session.humanPlayer, session.status(), live.enclosedCastlesByPlayer);

    scene.drawEffects(
      session.state,
      session.tickFraction,
      delta,
      live.castleEnclosed,
      advanceFloods(),
      session.humanPlayer,
    );
    const ghost = { ...controls.ghost(), ...hints };
    scene.drawOverlay(session.state, ghost, session.humanPlayer);
    drawCounters(ghost);
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
    styles: preferredStyles(),
    name: 'Player',
    settings: settingsFromParams(),
    // &teams=N puts the seats in teams of N, in seat order, when N divides the table.
    ...(Number(params.get('teams') ?? 1) > 1 && count % Number(params.get('teams')) === 0
      ? { teams: defaultTeams(count, Number(params.get('teams'))) }
      : {}),
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
  // The lobby had no way in except clicking through the menu, which meant it could not
  // be looked at the way `?autostart=1` lets a match be looked at — and it went
  // un-inspected at more than four seats for exactly that long.
  const joining = params.get('join');
  const common: Common = {
    seed: Number(params.get('seed') ?? 1),
    styles: preferredStyles(),
    name: params.get('name') ?? 'Player',
  };
  void openLobby(common, joining, Number(params.get('host') ?? DEFAULT_PLAYERS)).catch(
    (error: unknown) => showError(joining !== null ? 'Could not join' : 'Could not host', error),
  );
} else {
  showMenu();
}
