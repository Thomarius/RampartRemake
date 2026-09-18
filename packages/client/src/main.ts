import {
  ArtStyleSchema,
  defaultArtConfig,
  defaultConfigBundle,
  validateConfigBundle,
  type ArtStyle,
} from '@rampart/config';
import type { Seat } from '@rampart/protocol';
import { PHASES, type Action, type MatchEvent, type MatchState, type Phase } from '@rampart/sim';

import { Controls } from './controls.js';
import { Hud } from './hud.js';
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
  players: number;
  seed: number;
  style: ArtStyle;
  name: string;
}

function readSetup(): Setup {
  return {
    players: Number(document.querySelector<HTMLSelectElement>('#players')?.value ?? 3),
    seed: Number(document.querySelector<HTMLInputElement>('#seed')?.value ?? 1),
    style: ArtStyleSchema.catch(defaultArtConfig.style).parse(
      document.querySelector<HTMLSelectElement>('#style')?.value,
    ),
    name: document.querySelector<HTMLInputElement>('#name')?.value.trim() || 'Player',
  };
}

function showMenu(): void {
  app!.innerHTML = `
    <div class="menu">
      <h1>Rampart</h1>
      <p>Shoot down their walls. Rebuild yours before the next barrage.
         Fail to seal a castle and you are out.</p>
      <label>Name <input id="name" type="text" maxlength="16" value="Player" /></label>
      <label>Players
        <select id="players"><option value="2">2</option><option value="3" selected>3</option><option value="4">4</option></select>
      </label>
      <label>Seed <input id="seed" type="number" value="1" min="0" step="1" /></label>
      <label>Style
        <select id="style">
          <option value="pixel">Pixel art</option>
          <option value="flat">Minimal</option>
        </select>
      </label>
      <button id="solo">Play offline</button>
      <div class="split">
        <button id="host">Host online</button>
        <span>or</span>
        <input id="code" type="text" maxlength="8" placeholder="room code" />
        <button id="join">Join</button>
      </div>
      <p class="note">Offline opponents play legal moves without a plan — real bots arrive in M5.</p>
    </div>
  `;
  const styleField = document.querySelector<HTMLSelectElement>('#style');
  if (styleField) styleField.value = preferredStyle;

  document.querySelector('#solo')?.addEventListener('click', () => {
    const setup = readSetup();
    const match = new LocalMatch({ seed: setup.seed, playerCount: setup.players, humanPlayer: 0 });
    void runSession(
      {
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
        status: () => '',
      },
      setup,
    ).catch((error: unknown) => showError('Failed to start match', error));
  });

  document.querySelector('#host')?.addEventListener('click', () => {
    void startOnline(readSetup(), null).catch((e: unknown) => showError('Could not host', e));
  });
  document.querySelector('#join')?.addEventListener('click', () => {
    const code = document.querySelector<HTMLInputElement>('#code')?.value.trim() ?? '';
    if (code.length === 0) return;
    void startOnline(readSetup(), code).catch((e: unknown) => showError('Could not join', e));
  });
}

// ----------------------------------------------------------------------- lobby

const TOKEN_KEY = 'rampart.seat';

async function startOnline(setup: Setup, code: string | null): Promise<void> {
  const connection = new ServerConnection(ServerConnection.defaultUrl());
  const match = new NetworkMatch(connection);

  let seats: Seat[] = [];
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
    app!.innerHTML = `
      <div class="menu lobby">
        <h1>Room ${roomCode}</h1>
        <p>Share this code. Empty seats are filled by bots when the match starts.</p>
        <ul class="seats">${seats
          .map(
            (seat) =>
              `<li${seat.playerId === match.humanPlayer ? ' class="you"' : ''}>${seat.name}${
                seat.playerId === hostId ? ' <em>host</em>' : ''
              }${seat.connected ? '' : ' <em>away</em>'}</li>`,
          )
          .join('')}</ul>
        ${isHost ? '<button id="begin">Start match</button>' : '<p class="note">Waiting for the host to start.</p>'}
        <button id="leave" class="quiet">Leave</button>
      </div>
    `;
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
  if (code === null) connection.createRoom(setup.name, setup.players);
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
  const controls = new Controls(canvas, scene, session.state, session.humanPlayer, (action) => {
    session.submit(action);
  });
  controls.attach();

  const fit = (): void => {
    scene.resize(session.state, globalThis.innerWidth, globalThis.innerHeight);
    scene.drawTerrain(session.state);
    scene.drawTerritory(session.state);
    scene.drawStructures(session.state);
  };
  fit();
  globalThis.addEventListener('resize', fit);

  const restart = (event: KeyboardEvent): void => {
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

    applyEvents(session.advance(delta));
    announceWhenDue();
    hud.update(session.state, session.humanPlayer, session.status());

    scene.drawEffects(session.state, session.tickFraction, delta);
    scene.drawOverlay(session.state, controls.ghost(), session.humanPlayer);
    scene.render();

    frame = requestAnimationFrame(loop);
  };
  frame = requestAnimationFrame(loop);
}

if (params.get('autostart') === '1') {
  const setup: Setup = {
    players: Number(params.get('players') ?? 3),
    seed: Number(params.get('seed') ?? 1),
    style: preferredStyle,
    name: 'Player',
  };
  const match = new LocalMatch({ seed: setup.seed, playerCount: setup.players, humanPlayer: 0 });
  const phase = params.get('snapshot');
  if (phase !== null && PHASES.includes(phase as Phase)) match.fastForwardTo(phase as Phase);
  void runSession(
    {
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
      status: () => '',
    },
    setup,
  ).catch((error: unknown) => showError('Failed to start match', error));
} else {
  showMenu();
}
