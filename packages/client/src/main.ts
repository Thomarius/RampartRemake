import { defaultConfigBundle, validateConfigBundle } from '@rampart/config';

// M0 smoke test: prove the shared config bundle resolves and validates inside the
// browser bundle, the same values the server will run. Rendering arrives in M2.
const problems = validateConfigBundle(defaultConfigBundle);
const { ruleset, terrain } = defaultConfigBundle;

const rows: [string, string][] = [
  ['grid', `${terrain.gridWidth} x ${terrain.gridHeight}`],
  ['players', `${ruleset.players.min} - ${ruleset.players.max}`],
  ['castles / island', String(terrain.castles.perIsland)],
  ['tick rate', `${ruleset.tickRateHz} Hz`],
  ['combat phase', `${ruleset.phases.combatMs / 1000}s`],
  ['build phase', `${ruleset.phases.buildMs / 1000}s`],
  ['config', problems.length === 0 ? 'valid' : problems.join('; ')],
];

const app = document.querySelector<HTMLElement>('#app');
if (app) {
  app.innerHTML = `<h1>Rampart</h1><dl>${rows
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
    .join('')}</dl>`;
}
