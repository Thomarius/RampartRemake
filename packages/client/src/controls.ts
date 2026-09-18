import {
  canPlaceCannon,
  canPlacePiece,
  currentPieceId,
  findReadyCannon,
  pieceCells,
  type Action,
  type MatchState,
} from '@rampart/sim';

import type { Ghost, Scene } from './render/scene.js';

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
        this.rotation++;
        event.preventDefault();
        return;
      }
      move(event);
      this.commit();
    };
    const wheel = (event: WheelEvent): void => {
      this.rotation += event.deltaY > 0 ? 1 : -1;
      event.preventDefault();
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'r' || event.key === 'R') this.rotation++;
      else if (event.key === 'e' || event.key === 'E') this.rotation--;
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

  private commit(): void {
    const tile = this.hover;
    if (tile === null) return;
    const player = this.humanPlayer;

    switch (this.state.phase) {
      case 'castle_select': {
        const castle = this.castleAt(tile.x, tile.y);
        if (castle) this.submit({ kind: 'select_castle', player, castleId: castle.id });
        return;
      }
      case 'combat':
        this.submit({ kind: 'fire', player, x: tile.x, y: tile.y });
        return;
      case 'build':
        this.submit({ kind: 'place_piece', player, x: tile.x, y: tile.y, rotation: this.rotation });
        return;
      case 'cannon_place':
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

    const selectable =
      state.phase === 'castle_select' && state.players[player]?.startingCastleId === null
        ? state.castles.filter((c) => c.islandId === islandId)
        : [];

    if (tile === null) {
      return { tile: null, cells: [], valid: false, footprint: null, selectable };
    }

    switch (state.phase) {
      case 'build': {
        const cells = pieceCells(currentPieceId(state, player), this.rotation);
        const valid = canPlacePiece(state, player, this.rotation, tile.x, tile.y) === null;
        return { tile, cells, valid, footprint: null, selectable };
      }
      case 'cannon_place': {
        const [w, h] = state.ruleset.cannons.footprint;
        const valid = canPlaceCannon(state, player, tile.x, tile.y) === null;
        return { tile, cells: [], valid, footprint: { w, h }, selectable };
      }
      case 'combat': {
        const valid = findReadyCannon(state, player, tile.x, tile.y) !== null;
        return { tile, cells: [], valid, footprint: null, selectable };
      }
      case 'castle_select': {
        return {
          tile,
          cells: [],
          valid: this.castleAt(tile.x, tile.y) !== undefined,
          footprint: null,
          selectable,
        };
      }
      default:
        return { tile, cells: [], valid: false, footprint: null, selectable };
    }
  }
}
