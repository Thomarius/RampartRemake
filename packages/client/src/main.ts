import { defaultConfigBundle, validateConfigBundle } from '@rampart/config';
import { PHASES, type MatchEvent, type Phase } from '@rampart/sim';

import { Controls } from './controls.js';
import { Hud } from './hud.js';
import { LocalMatch } from './localMatch.js';
import { Scene } from './scene.js';

/**
 * M2: the simulation, in a browser, with placeholder rectangles.
 *
 * No server and no art — this build exists to answer one question, which is
 * whether the loop is fun with these rules. Everything here is replaced: the
 * renderer in M3, the local match by an authoritative server in M4, and the
 * scripted opponents by real bots in M5.
 */

const problems = validateConfigBundle(defaultConfigBundle);
if (problems.length > 0) {
  throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
}

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('missing #app');

/**
 * Surfaces failures on the page rather than only in the console. A renderer that
 * throws on the first frame otherwise looks identical to a black screen, both to
 * a person and to an automated screenshot.
 */
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

interface Setup {
  players: number;
  seed: number;
}

function showMenu(onStart: (setup: Setup) => void): void {
  app!.innerHTML = `
    <div class="menu">
      <h1>Rampart</h1>
      <p>Shoot down their walls. Rebuild yours before the next barrage.
         Fail to seal a castle and you are out.</p>
      <label>Players
        <select id="players">
          <option value="2">2</option>
          <option value="3" selected>3</option>
          <option value="4">4</option>
        </select>
      </label>
      <label>Seed <input id="seed" type="number" value="1" min="0" step="1" /></label>
      <button id="start">Start match</button>
      <p class="note">Opponents play legal moves without a plan — real bots arrive in M5.</p>
    </div>
  `;
  const start = document.querySelector<HTMLButtonElement>('#start');
  start?.addEventListener('click', () => {
    onStart({
      players: Number(document.querySelector<HTMLSelectElement>('#players')?.value ?? 3),
      seed: Number(document.querySelector<HTMLInputElement>('#seed')?.value ?? 1),
    });
  });
}

const params = new URLSearchParams(globalThis.location.search);

/** Dev only: ?speed=20 runs the clock faster, to reach a later phase quickly. */
const timeScale = Math.max(1, Number(params.get('speed') ?? 1));

async function runMatch(setup: Setup): Promise<void> {
  app!.innerHTML = `<canvas id="stage"></canvas><div id="hud"></div><div id="banner"></div>`;
  const canvas = document.querySelector<HTMLCanvasElement>('#stage');
  const hudRoot = document.querySelector<HTMLElement>('#hud');
  const bannerRoot = document.querySelector<HTMLElement>('#banner');
  if (!canvas || !hudRoot || !bannerRoot) throw new Error('missing stage');

  const match = new LocalMatch({ seed: setup.seed, playerCount: setup.players, humanPlayer: 0 });
  const scene = new Scene();
  await scene.init(canvas);

  const hud = new Hud(hudRoot, bannerRoot);
  const controls = new Controls(canvas, scene, match.state, match.humanPlayer, (action) => {
    match.submit(action);
  });
  controls.attach();

  // Dev only: ?snapshot=build puts a given phase on screen immediately.
  const snapshot = params.get('snapshot');
  if (snapshot !== null && PHASES.includes(snapshot as Phase)) {
    match.fastForwardTo(snapshot as Phase);
  }

  const fit = (): void => {
    // Pixi's autoDensity writes inline width/height onto the canvas, so measuring
    // the canvas itself would feed its own previous size back in. Measure the window.
    scene.resize(match.state, globalThis.innerWidth, globalThis.innerHeight);
    scene.drawTerrain(match.state);
    scene.drawTerritory(match.state);
    scene.drawStructures(match.state);
  };
  fit();
  globalThis.addEventListener('resize', fit);

  const restart = (event: KeyboardEvent): void => {
    if ((event.key === 'r' || event.key === 'R') && match.finished) {
      cleanup();
      showMenu((next) => void runMatch(next));
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

  let last = performance.now();
  const loop = (now: number): void => {
    const delta = now - last;
    last = now;

    const events = match.advance(delta * timeScale);
    applyEvents(events);
    announceWhenDue();
    hud.update(match.state, match.humanPlayer);

    scene.drawEffects(match.state, match.tickFraction, delta);
    scene.drawOverlay(match.state, controls.ghost(), match.humanPlayer);
    scene.render();

    frame = requestAnimationFrame(loop);
  };

  const bannerTicks = Math.ceil(
    (match.state.ruleset.phases.transitionBannerMs * match.state.ruleset.tickRateHz) / 1000,
  );
  let announcedAt: number | null = null;

  /**
   * Fires the announcement once the end-of-phase pause is over, and once only.
   *
   * Keyed off the intermission's end tick rather than its start: while shots are
   * still in the air the simulation keeps pushing that end back, and the banner
   * should play against the settled clock, not the moment combat stopped.
   */
  function announceWhenDue(): void {
    const state = match.state;
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
        case 'piece_placed':
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
          // The starting wall ring is laid down as castle selection ends, so a
          // phase change can carry grid changes with it. Without this the rings
          // stayed invisible until the first cannonball happened to land.
          structuresChanged = true;
          break;
        default:
          break;
      }
    }
    if (structuresChanged) scene.drawStructures(match.state);
    if (territoryChanged) scene.drawTerritory(match.state);
  }

  frame = requestAnimationFrame(loop);
}

// Dev convenience: ?autostart=1&players=3&seed=7 skips the menu, so a browser can
// be pointed straight at a running match for a screenshot or a manual look.
if (params.get('autostart') === '1') {
  void runMatch({
    players: Number(params.get('players') ?? 3),
    seed: Number(params.get('seed') ?? 1),
  }).catch((error: unknown) => showError('Failed to start match', error));
} else {
  showMenu((setup) => {
    void runMatch(setup).catch((error: unknown) => showError('Failed to start match', error));
  });
}
