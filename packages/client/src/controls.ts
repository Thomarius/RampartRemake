import {
  canPlaceCannon,
  canPlacePiece,
  currentPieceId,
  findReadyCannon,
  owesCastleChoice,
  pieceCells,
  type Action,
  type MatchState,
} from '@rampart/sim';

import type { Ghost, Scene } from './render/scene.js';

/** What a click means for this player right now. */
export type InputMode = 'castle' | 'cannon' | 'piece' | 'fire' | 'none';

/**
 * What a click means for a player, from the state alone.
 *
 * Mostly the phase — but a player who has just spent a continue has no castle, and
 * chooses one in the cannon phase before placing any guns, exactly as at the start of
 * the match. Keyed on the phase alone, the controls offered that player a cannon they
 * had nowhere to put, and no way to choose the castle the sim was waiting for.
 */
export function inputMode(state: MatchState, playerId: number): InputMode {
  const player = state.players[playerId];
  if (player === undefined || player.eliminated) return 'none';
  switch (state.phase) {
    case 'castle_select':
      return owesCastleChoice(player) ? 'castle' : 'none';
    case 'cannon_place':
      return owesCastleChoice(player) ? 'castle' : 'cannon';
    case 'build':
      return 'piece';
    case 'combat':
      return 'fire';
    default:
      return 'none';
  }
}

/** The two cues the simulation never sees, because neither changes the match. */
type InputCue = 'piece_rotate' | 'piece_invalid';

/**
 * Pointer and keyboard handling.
 *
 * Every phase uses the same two gestures — move to aim, click to commit — so the
 * player never has to learn a new control scheme mid-match. Rotation is the only
 * extra verb, and only the build phase uses it.
 */
export class Controls {
  private hover: { x: number; y: number } | null = null;
  private rotation = 0;
  private detachers: (() => void)[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly scene: Scene,
    private readonly state: MatchState,
    private readonly humanPlayer: number,
    private readonly submit: (action: Action) => void,
    private readonly cue: (cue: InputCue) => void = () => {},
  ) {}

  attach(): void {
    const move = (event: PointerEvent): void => {
      const rect = this.canvas.getBoundingClientRect();
      this.hover = this.scene.tileAt(
        this.state,
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
    };
    const leave = (): void => {
      this.hover = null;
    };
    const down = (event: PointerEvent): void => {
      if (event.button === 2) {
        this.rotate(1);
        event.preventDefault();
        return;
      }
      move(event);
      this.commit();
    };
    const wheel = (event: WheelEvent): void => {
      this.rotate(event.deltaY > 0 ? 1 : -1);
      event.preventDefault();
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'r' || event.key === 'R') this.rotate(1);
      else if (event.key === 'e' || event.key === 'E') this.rotate(-1);
      else return;
      event.preventDefault();
    };
    const contextMenu = (event: Event): void => event.preventDefault();

    this.canvas.addEventListener('pointermove', move);
    this.canvas.addEventListener('pointerleave', leave);
    this.canvas.addEventListener('pointerdown', down);
    this.canvas.addEventListener('wheel', wheel, { passive: false });
    this.canvas.addEventListener('contextmenu', contextMenu);
    globalThis.addEventListener('keydown', key);

    this.detachers = [
      () => this.canvas.removeEventListener('pointermove', move),
      () => this.canvas.removeEventListener('pointerleave', leave),
      () => this.canvas.removeEventListener('pointerdown', down),
      () => this.canvas.removeEventListener('wheel', wheel),
      () => this.canvas.removeEventListener('contextmenu', contextMenu),
      () => globalThis.removeEventListener('keydown', key),
    ];
  }

  detach(): void {
    for (const off of this.detachers) off();
    this.detachers = [];
  }

  /** Resets rotation between phases so a new piece starts upright. */
  resetRotation(): void {
    this.rotation = 0;
  }

  /** Rotation is only a verb during the build phase, so only there does it speak. */
  private rotate(by: number): void {
    this.rotation += by;
    if (this.state.phase === 'build') this.cue('piece_rotate');
  }

  private commit(): void {
    const tile = this.hover;
    if (tile === null) return;
    const player = this.humanPlayer;

    switch (inputMode(this.state, player)) {
      case 'castle': {
        const castle = this.castleAt(tile.x, tile.y);
        if (castle) this.submit({ kind: 'select_castle', player, castleId: castle.id });
        else this.cue('piece_invalid');
        return;
      }
      case 'fire': {
        // Your own island is refused by the sim, so say so here rather than send it.
        const own = this.state.islandId[tile.y * this.state.width + tile.x];
        const mine = own === this.state.players[player]?.islandId;
        if (mine && !this.state.ruleset.shots.damagesOwnWalls) this.cue('piece_invalid');
        else this.submit({ kind: 'fire', player, x: tile.x, y: tile.y });
        return;
      }
      case 'piece':
        if (canPlacePiece(this.state, player, this.rotation, tile.x, tile.y) !== null) {
          this.cue('piece_invalid');
        }
        this.submit({ kind: 'place_piece', player, x: tile.x, y: tile.y, rotation: this.rotation });
        return;
      case 'cannon':
        if (canPlaceCannon(this.state, player, tile.x, tile.y) !== null) this.cue('piece_invalid');
        this.submit({ kind: 'place_cannon', player, x: tile.x, y: tile.y });
        return;
      default:
        return;
    }
  }

  private castleAt(x: number, y: number) {
    const islandId = this.state.players[this.humanPlayer]?.islandId;
    return this.state.castles.find(
      (c) => c.islandId === islandId && x >= c.x && y >= c.y && x < c.x + c.w && y < c.y + c.h,
    );
  }

  /** What the overlay should draw this frame. */
  ghost(): Ghost {
    const state = this.state;
    const player = this.humanPlayer;
    const tile = this.hover;
    const islandId = state.players[player]?.islandId;

    const mode = inputMode(state, player);
    const selectable =
      mode === 'castle' ? state.castles.filter((c) => c.islandId === islandId) : [];

    if (tile === null) {
      return {
        tile: null,
        cells: [],
        valid: false,
        footprint: null,
        selectable,
        leak: [],
        unsealed: [],
      };
    }

    switch (mode) {
      case 'piece': {
        const cells = pieceCells(currentPieceId(state, player), this.rotation);
        const valid = canPlacePiece(state, player, this.rotation, tile.x, tile.y) === null;
        return { tile, cells, valid, footprint: null, selectable, leak: [], unsealed: [] };
      }
      case 'cannon': {
        const [w, h] = state.ruleset.cannons.footprint;
        const valid = canPlaceCannon(state, player, tile.x, tile.y) === null;
        return { tile, cells: [], valid, footprint: { w, h }, selectable, leak: [], unsealed: [] };
      }
      case 'fire': {
        const valid = findReadyCannon(state, player, tile.x, tile.y) !== null;
        return { tile, cells: [], valid, footprint: null, selectable, leak: [], unsealed: [] };
      }
      case 'castle': {
        return {
          tile,
          cells: [],
          valid: this.castleAt(tile.x, tile.y) !== undefined,
          footprint: null,
          selectable,
          leak: [],
          unsealed: [],
        };
      }
      default:
        return {
          tile,
          cells: [],
          valid: false,
          footprint: null,
          selectable,
          leak: [],
          unsealed: [],
        };
    }
  }
}
