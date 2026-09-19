import { defaultRuleset, defaultTerrainConfig, type Ruleset } from '@rampart/config';
import { Bot, type Difficulty } from '@rampart/ai';

import {
  Rng,
  applyAction,
  createMatch,
  drainEvents,
  step,
  type Action,
  type MatchEvent,
  type MatchState,
  type Phase,
  type Rejection,
} from '@rampart/sim';

export interface LocalMatchOptions {
  seed: number;
  /**
   * One entry per seat: `null` for the person at the keyboard, otherwise the skill
   * of the bot playing it. Every entry being a difficulty is a watching match, which
   * is the clearest way to see how the bots actually play.
   */
  seats: readonly (Difficulty | null)[];
  ruleset?: Ruleset;
}

/**
 * A match running entirely in the browser, with no server.
 *
 * Opponents are driven by the simulation's scripted playout driver — legal moves
 * without a plan. They are not opponents worth beating; they exist so the combat
 * and build phases have something happening in them while the loop is evaluated.
 * Real bots arrive in M5, and the authoritative server in M4.
 */
export class LocalMatch {
  readonly state: MatchState;
  /** Seat the person holds, or -1 when nobody is playing and the match is watched. */
  readonly humanPlayer: number;
  private readonly rng: Rng;
  private readonly bots = new Map<number, Bot>();
  private readonly tickMs: number;
  private accumulator = 0;
  private events: MatchEvent[] = [];

  constructor(options: LocalMatchOptions) {
    const ruleset = options.ruleset ?? defaultRuleset;
    const seats = options.seats;
    this.humanPlayer = seats.findIndex((seat) => seat === null);

    this.state = createMatch({
      seed: options.seed,
      ruleset,
      terrainConfig: defaultTerrainConfig,
      players: seats.map((seat, i) => ({
        name: seat === null ? 'You' : `${seat[0]?.toUpperCase()}${seat.slice(1)} ${i + 1}`,
        isBot: seat !== null,
      })),
    });

    for (const [id, seat] of seats.entries()) {
      if (seat !== null) this.bots.set(id, new Bot(id, seat));
    }
    this.rng = new Rng(options.seed ^ 0x5f3759df);
    this.tickMs = 1000 / ruleset.tickRateHz;
  }

  /** Fraction of the way into the current tick, for smooth shot interpolation. */
  get tickFraction(): number {
    return Math.min(1, this.accumulator / this.tickMs);
  }

  get finished(): boolean {
    return this.state.phase === 'game_over';
  }

  /** Applies a human action immediately; returns null when accepted. */
  submit(action: Action): Rejection | null {
    return applyAction(this.state, action);
  }

  /**
   * Advances by real elapsed time, in fixed simulation ticks.
   *
   * The accumulator is capped so that a backgrounded tab does not return and
   * fast-forward through a whole phase the player never saw.
   */
  advance(elapsedMs: number): MatchEvent[] {
    if (this.finished) return this.takeEvents();
    this.accumulator += Math.min(elapsedMs, 250);
    while (this.accumulator >= this.tickMs && !this.finished) {
      this.accumulator -= this.tickMs;
      this.stepOnce();
    }
    return this.takeEvents();
  }

  /**
   * Runs the match forward with every seat, including the player's, driven by the
   * scripted driver. Dev only: it exists so a given phase can be put on screen
   * deterministically, without waiting out the clock or playing to get there.
   */
  fastForwardTo(phase: Phase, maxTicks = 40_000): void {
    while (this.state.phase !== phase && this.state.tick < maxTicks && !this.finished) {
      for (const player of this.state.players) {
        if (player.eliminated) continue;
        const action = this.botFor(player.id).think(this.state, this.rng);
        if (action !== null) applyAction(this.state, action);
      }
      step(this.state);
      drainEvents(this.state);
    }
  }

  private stepOnce(): void {
    for (const player of this.state.players) {
      if (player.id === this.humanPlayer || player.eliminated) continue;
      const action = this.bots.get(player.id)?.think(this.state, this.rng) ?? null;
      if (action !== null) applyAction(this.state, action);
    }
    step(this.state);
    this.events.push(...drainEvents(this.state));
  }

  /** Fast-forwarding drives every seat, including the person's. */
  private botFor(playerId: number): Bot {
    let bot = this.bots.get(playerId);
    if (!bot) {
      bot = new Bot(playerId, 'gunner');
      this.bots.set(playerId, bot);
    }
    return bot;
  }

  private takeEvents(): MatchEvent[] {
    const events = this.events;
    this.events = [];
    return events;
  }
}
