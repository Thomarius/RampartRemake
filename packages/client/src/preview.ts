import type { ArtConfig, PlayerPalette, TerrainConfig } from '@rampart/config';
import {
  Terrain,
  denseTeams,
  generateTerrain,
  seatOrder,
  type GeneratedTerrain,
} from '@rampart/sim';

import { matchPalette } from './colours.js';

/**
 * The table's map, before the match: the islands the seed will generate, which island
 * each seat will be dealt, and the colour it will play in.
 *
 * Possible because the seed is fixed when the table is set rather than when the match
 * starts, and because everything else follows from it — the terrain is generated from
 * the seed alone, and seats are shuffled onto islands by `seatOrder(seed, seats)`, which
 * the server and a local match both use. Seats are in lobby order: the host first, then
 * people in the order they joined, then the bots — the order a match is started in.
 */
export interface TablePreview {
  terrain: GeneratedTerrain;
  /** The player each seat becomes, so the island it gets is this + 1. */
  playerOfSeat: number[];
  /** Colours by seat. */
  colourOfSeat: PlayerPalette[];
}

/** Terrain is the slow part and depends on two numbers, so the last few are kept. */
const terrains = new Map<string, GeneratedTerrain>();

function terrainFor(config: TerrainConfig, playerCount: number, seed: number): GeneratedTerrain {
  const key = `${seed}:${playerCount}`;
  let terrain = terrains.get(key);
  if (terrain === undefined) {
    terrain = generateTerrain(config, playerCount, seed);
    if (terrains.size > 8) terrains.clear();
    terrains.set(key, terrain);
  }
  return terrain;
}

export function tablePreview(
  seed: number,
  playerCount: number,
  teamsBySeat: readonly number[],
  art: ArtConfig,
  terrainConfig: TerrainConfig,
): TablePreview {
  const terrain = terrainFor(terrainConfig, playerCount, seed);
  const playerOfSeat = seatOrder(seed, playerCount);
  // The match's own palette rule, over the players the seats will become, with team
  // ids made exactly as `createMatch` makes them — the colour family follows the id.
  const labels = new Array<number | undefined>(playerCount);
  playerOfSeat.forEach((player, seat) => {
    labels[player] = teamsBySeat[seat];
  });
  const players = denseTeams(labels).map((team, id) => ({ id, team }));
  const byPlayer = matchPalette(art, { players });
  const colourOfSeat = playerOfSeat.map((player) => byPlayer[player] as PlayerPalette);
  return { terrain, playerOfSeat, colourOfSeat };
}

/** The middle of each island, by island id, for its label. */
export function islandCentres(terrain: GeneratedTerrain): Map<number, { x: number; y: number }> {
  const sums = new Map<number, { x: number; y: number; n: number }>();
  for (let i = 0; i < terrain.islandId.length; i++) {
    const island = terrain.islandId[i] as number;
    if (island === 0 || terrain.terrain[i] !== Terrain.Land) continue;
    const x = i % terrain.width;
    const entry = sums.get(island) ?? { x: 0, y: 0, n: 0 };
    entry.x += x;
    entry.y += (i - x) / terrain.width;
    entry.n++;
    sums.set(island, entry);
  }
  const centres = new Map<number, { x: number; y: number }>();
  for (const [island, sum] of sums) centres.set(island, { x: sum.x / sum.n, y: sum.y / sum.n });
  return centres;
}

/**
 * Paints the preview: sea, each island in its seat's colour with its castles, and the
 * seat's number over it — the same number the seat's card carries — with the viewer's
 * own island ringed. Pixel-exact at a whole-number scale, like the game's pixel style.
 */
export function drawPreview(
  canvas: HTMLCanvasElement,
  preview: TablePreview,
  viewerSeat: number,
  art: ArtConfig,
  maxWidthPx: number,
): void {
  const { terrain } = preview;
  const scale = Math.max(2, Math.floor(maxWidthPx / terrain.width));
  canvas.width = terrain.width * scale;
  canvas.height = terrain.height * scale;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return;
  ctx.imageSmoothingEnabled = false;

  ctx.fillStyle = art.palette.waterMid;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const seatOfIsland = new Map<number, number>();
  preview.playerOfSeat.forEach((player, seat) => seatOfIsland.set(player + 1, seat));

  for (let i = 0; i < terrain.terrain.length; i++) {
    if (terrain.terrain[i] !== Terrain.Land) continue;
    const seat = seatOfIsland.get(terrain.islandId[i] as number);
    const colour = seat === undefined ? undefined : preview.colourOfSeat[seat];
    const x = i % terrain.width;
    const y = (i - x) / terrain.width;
    ctx.fillStyle = colour?.dark ?? art.palette.grassMid;
    ctx.fillRect(x * scale, y * scale, scale, scale);
  }

  for (const castle of terrain.castles) {
    const seat = seatOfIsland.get(castle.islandId);
    ctx.fillStyle = (seat === undefined ? undefined : preview.colourOfSeat[seat]?.light) ?? '#fff';
    ctx.fillRect(castle.x * scale, castle.y * scale, castle.w * scale, castle.h * scale);
  }

  const centres = islandCentres(terrain);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${Math.max(11, scale * 5)}px ui-monospace, Menlo, Consolas, monospace`;
  for (const [island, centre] of centres) {
    const seat = seatOfIsland.get(island);
    if (seat === undefined) continue;
    const cx = (centre.x + 0.5) * scale;
    const cy = (centre.y + 0.5) * scale;
    ctx.fillStyle = 'rgb(10 10 18 / 60%)';
    ctx.fillText(String(seat + 1), cx + 1, cy + 1);
    ctx.fillStyle = art.palette.uiInk;
    ctx.fillText(String(seat + 1), cx, cy);
  }

  // The viewer's island, outlined, so "where am I" needs no looking up.
  const mine = preview.playerOfSeat[viewerSeat];
  if (mine === undefined) return;
  ctx.fillStyle = art.palette.uiAccent;
  for (let i = 0; i < terrain.terrain.length; i++) {
    if (terrain.islandId[i] !== mine + 1 || terrain.terrain[i] !== Terrain.Land) continue;
    const x = i % terrain.width;
    const y = (i - x) / terrain.width;
    const edge = (nx: number, ny: number): boolean =>
      nx < 0 ||
      ny < 0 ||
      nx >= terrain.width ||
      ny >= terrain.height ||
      terrain.islandId[ny * terrain.width + nx] !== mine + 1 ||
      terrain.terrain[ny * terrain.width + nx] !== Terrain.Land;
    const line = Math.max(1, Math.floor(scale / 2));
    if (edge(x, y - 1)) ctx.fillRect(x * scale, y * scale, scale, line);
    if (edge(x, y + 1)) ctx.fillRect(x * scale, (y + 1) * scale - line, scale, line);
    if (edge(x - 1, y)) ctx.fillRect(x * scale, y * scale, line, scale);
    if (edge(x + 1, y)) ctx.fillRect((x + 1) * scale - line, y * scale, line, scale);
  }
}
