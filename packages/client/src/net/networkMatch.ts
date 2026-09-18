import { applySnapshot, type ServerMessage } from '@rampart/protocol';
import {
  applyAction,
  createMatch,
  drainEvents,
  hashMatchState,
  step,
  type Action,
  type MatchEvent,
  type MatchState,
  type Rejection,
} from '@rampart/sim';

import type { ServerConnection } from './connection.js';

/**
 * A match played against an authoritative server.
 *
 * The client runs the same simulation the server does and replays the actions the
 * server confirms, rather than being sent the board. It never runs ahead of what has
 * been confirmed, so it cannot show something that did not happen — the cost is that
 * a player's own action appears after one round trip. At the scale of this game that
 * is well under the flight time of a cannonball, and the alternative, predicting
 * locally and rolling back, would buy very little for a great deal of complexity.
 */
export class NetworkMatch {
  state: MatchState | null = null;
  /** Highest tick the server has confirmed; the simulation may reach tick + 1. */
  private confirmed = -1;
  private buffered = new Map<number, Action[]>();
  private events: MatchEvent[] = [];
  private accumulatorMs = 0;
  private tickMs = 1000 / 30;

  humanPlayer = -1;
  desynced = false;
  lastRejection: Rejection | null = null;

  constructor(private readonly connection: ServerConnection) {}

  get ready(): boolean {
    return this.state !== null;
  }

  get finished(): boolean {
    return this.state?.phase === 'game_over';
  }

  get tickFraction(): number {
    return Math.min(1, this.accumulatorMs / this.tickMs);
  }

  /** Ticks the client is behind the server; a rising number means it cannot keep up. */
  get behind(): number {
    return this.state === null ? 0 : Math.max(0, this.confirmed + 1 - this.state.tick);
  }

  receive(message: ServerMessage): void {
    switch (message.type) {
      case 'welcome':
        this.humanPlayer = message.playerId;
        return;

      case 'snapshot': {
        // Terrain and the piece sequence are regenerated from the seed rather than
        // sent, which is only sound because generation is deterministic.
        const base = createMatch({
          seed: message.snapshot.seed,
          ruleset: message.snapshot.ruleset,
          terrainConfig: message.snapshot.terrain,
          players: message.snapshot.players.map((p) => ({ name: p.name, isBot: p.isBot })),
        });
        applySnapshot(base, message.snapshot);
        this.state = base;
        this.tickMs = 1000 / base.ruleset.tickRateHz;
        this.confirmed = message.snapshot.tick - 1;
        this.buffered.clear();
        return;
      }

      case 'commit': {
        this.buffered.set(message.tick, message.actions);
        this.confirmed = Math.max(this.confirmed, message.tick);
        if (message.hash !== undefined)
          this.pendingHash = { tick: message.tick, hash: message.hash };
        return;
      }

      case 'rejected':
        this.lastRejection = message.reason as Rejection;
        return;

      default:
        return;
    }
  }

  private pendingHash: { tick: number; hash: string } | null = null;

  submit(action: Action): void {
    this.connection.send({ type: 'action', action });
  }

  /**
   * Advances by elapsed time, but never past what the server has confirmed. If the
   * client has fallen behind — a stalled tab, a slow frame — it catches up rather
   * than drifting permanently.
   */
  advance(elapsedMs: number): MatchEvent[] {
    const state = this.state;
    if (state === null) return [];

    this.accumulatorMs += Math.min(elapsedMs, 250);
    let budget = this.behind > 60 ? this.behind : Math.floor(this.accumulatorMs / this.tickMs);

    while (budget > 0 && state.tick <= this.confirmed) {
      const actions = this.buffered.get(state.tick);
      if (actions) {
        for (const action of actions) applyAction(state, action);
        this.buffered.delete(state.tick);
      }
      const tick = state.tick;
      step(state);
      this.events.push(...drainEvents(state));
      this.accumulatorMs = Math.max(0, this.accumulatorMs - this.tickMs);
      budget--;

      if (this.pendingHash !== null && this.pendingHash.tick === tick) {
        if (hashMatchState(state) !== this.pendingHash.hash) this.desynced = true;
        this.pendingHash = null;
      }
    }

    const events = this.events;
    this.events = [];
    return events;
  }
}
