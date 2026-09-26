import {
  applySettings,
  defaultSettings,
  defaultTeams,
  mergeSettings,
  teamsBalanced,
  validPlayerCounts,
  type AiConfig,
  type MatchSettings,
  type Ruleset,
  type ServerConfig,
  type TerrainConfig,
} from '@rampart/config';
import { Bot, type Difficulty } from '@rampart/ai';
import {
  ActionSchema,
  PROTOCOL_VERSION,
  captureSnapshot,
  type ClientMessage,
  type Seat as WireSeat,
  type ServerMessage,
} from '@rampart/protocol';
import {
  Rng,
  applyAction,
  createMatch,
  drainEvents,
  hashMatchState,
  seatOrder,
  step,
  type Action,
  type MatchState,
} from '@rampart/sim';

/**
 * A client, abstracted away from WebSockets so a room can be driven directly in
 * tests. The integration suite runs a whole match between in-process clients with no
 * sockets and no timers at all.
 */
export interface Connection {
  readonly id: string;
  send(message: ServerMessage): void;
  close(reason: string): void;
}

interface Seat {
  playerId: number;
  name: string;
  /** Null while nobody is holding the seat: a bot plays it until someone returns. */
  connection: Connection | null;
  token: string;
  ready: boolean;
  /** True for a seat that was never claimed by a person. */
  bot: boolean;
  /** Ticks remaining before a dropped player is handed to a bot. */
  graceTicks: number;
}

export interface RoomOptions {
  code: string;
  hostName: string;
  playerCount: number;
  ruleset: Ruleset;
  terrain: TerrainConfig;
  server: ServerConfig;
  ai: AiConfig;
  seed?: number;
}

/** How often the server sends its state fingerprint for clients to check against. */
const HASH_EVERY_TICKS = 30;

/**
 * One match and its players.
 *
 * The server is the only authority: clients send intents, the server validates them
 * against the same rules everyone runs, and broadcasts what it actually applied. It
 * never sends board state during play — only the actions and the tick they landed on,
 * which every client replays into its own simulation. That is only safe because the
 * simulation is deterministic, so the periodic hash is not a nicety: it is the check
 * that the assumption still holds.
 */
export class Room {
  readonly code: string;
  private readonly seats: Seat[] = [];
  private readonly options: RoomOptions;
  private readonly rng: Rng;

  private state: MatchState | null = null;
  /** One per seat, created when the match starts: a bot keeps a plan between ticks. */
  private bots = new Map<number, Bot>();
  private accumulatorMs = 0;
  private pending: { seat: Seat; action: Action }[] = [];
  private hostId = 0;
  /** Skill of the bot in each seat, which the host may change before the match starts. */
  private readonly botDifficulties: Difficulty[];
  /** Settings the host may change before the match starts, within the server's bounds. */
  private settings: MatchSettings;
  /** Seats at the table, which the host may change while the table is being set. */
  private playerCount: number;
  /** Each seat's team, by seat. Free-for-all is every seat on its own. */
  private teams: number[];
  private idle = 0;

  constructor(options: RoomOptions) {
    this.options = options;
    this.code = options.code;
    this.rng = new Rng(options.seed ?? Math.floor(Math.random() * 0xffffffff));
    this.botDifficulties = new Array<Difficulty>(options.playerCount).fill(
      options.server.botDifficulty as Difficulty,
    );
    this.settings = defaultSettings(options.ruleset, options.server.lobbySettings);
    this.playerCount = options.playerCount;
    this.teams = defaultTeams(this.playerCount, this.settings.teamSize);
  }

  get started(): boolean {
    return this.state !== null;
  }

  get finished(): boolean {
    return this.state?.phase === 'game_over';
  }

  get empty(): boolean {
    return this.seats.every((seat) => seat.connection === null);
  }

  /** Milliseconds this room has had nobody connected. */
  get idleMs(): number {
    return this.idle;
  }

  // ---------------------------------------------------------------- membership

  join(connection: Connection, name: string, token?: string): number | null {
    if (token !== undefined) {
      const seat = this.seats.find((s) => s.token === token);
      if (seat) {
        // Reclaiming a seat a bot has been holding.
        seat.connection = connection;
        seat.bot = false;
        seat.graceTicks = 0;
        this.sendWelcome(seat);
        if (this.state) this.sendSnapshot(seat);
        this.broadcastRoom();
        return seat.playerId;
      }
    }

    if (this.state !== null) return null; // no new seats once a match is running
    if (this.seats.length >= this.playerCount) return null;

    const seat: Seat = {
      playerId: this.seats.length,
      name,
      connection,
      token: this.newToken(),
      ready: false,
      bot: false,
      graceTicks: 0,
    };
    this.seats.push(seat);
    if (this.seats.length === 1) this.hostId = seat.playerId;
    this.sendWelcome(seat);
    this.broadcastRoom();
    return seat.playerId;
  }

  leave(connection: Connection): void {
    const seat = this.seats.find((s) => s.connection?.id === connection.id);
    if (!seat) return;
    seat.connection = null;
    if (this.state === null) {
      // Nothing has started; drop the seat entirely and renumber nobody.
      const at = this.seats.indexOf(seat);
      this.seats.splice(at, 1);
      for (let i = 0; i < this.seats.length; i++) (this.seats[i] as Seat).playerId = i;
      if (this.seats.length > 0) this.hostId = (this.seats[0] as Seat).playerId;
    } else {
      // Mid-match: hold the seat open, and let a bot play it in the meantime so the
      // match does not stall for everyone else.
      seat.graceTicks = this.ticksFor(this.options.server.reconnect.botTakeoverDelayMs);
    }
    this.broadcastRoom();
  }

  handle(connection: Connection, message: ClientMessage): void {
    const seat = this.seats.find((s) => s.connection?.id === connection.id);
    if (!seat) return;

    switch (message.type) {
      case 'ready':
        seat.ready = message.ready;
        this.broadcastRoom();
        return;
      case 'start':
        if (seat.playerId === this.hostId) this.start();
        return;
      case 'configure': {
        // Only the host, and only while the table is still being set.
        if (seat.playerId !== this.hostId || this.state !== null) return;
        for (let i = 0; i < this.botDifficulties.length; i++) {
          const wanted = message.bots?.[i];
          if (wanted !== undefined) this.botDifficulties[i] = wanted as Difficulty;
        }
        let settings = this.settings;
        if (message.settings !== undefined) {
          // Only the fields actually sent: absent ones keep their current value.
          const change = Object.fromEntries(
            Object.entries(message.settings).filter(([, v]) => v !== undefined),
          ) as Partial<MatchSettings>;
          settings =
            mergeSettings(this.settings, change, this.options.server.lobbySettings) ?? settings;
        }
        this.configureTable(settings, message.playerCount ?? this.playerCount, message.teams);
        this.broadcastRoom();
        return;
      }
      case 'action': {
        // The seat decides who acted, never the message: otherwise a client could
        // move on another player's behalf simply by writing a different id.
        const action = ActionSchema.parse({ ...message.action, player: seat.playerId });
        this.pending.push({ seat, action });
        return;
      }
      case 'ping':
        connection.send({ type: 'pong', t: message.t, serverTick: this.state?.tick ?? 0 });
        return;
      default:
        return;
    }
  }

  /**
   * The table's shape: team size, seats, and who is on which team — changed together,
   * since each constrains the others. A team size needs a player count that makes at
   * least two equal teams; if the current count does not, the smallest that does and
   * seats everyone who has joined is taken. Changing either resets the teams to seat
   * order. An assignment the host sends is taken only if it makes equal teams.
   */
  private configureTable(
    settings: MatchSettings,
    playerCount: number,
    teams: readonly number[] | undefined,
  ): void {
    const limits = this.options.ruleset.players;
    const humans = this.seats.length;
    const valid = validPlayerCounts(settings.teamSize, limits).filter((n) => n >= humans);
    const count = valid.includes(playerCount)
      ? playerCount
      : (valid.find((n) => n >= this.playerCount) ?? valid[0]);
    if (count === undefined) return; // no table that size seats everyone who has joined

    const reshaped = settings.teamSize !== this.settings.teamSize || count !== this.playerCount;
    this.settings = settings;
    if (count !== this.playerCount) {
      // Seats kept keep their bot's skill; new ones take the server's default.
      this.playerCount = count;
      this.botDifficulties.length = count;
      for (let i = 0; i < count; i++) {
        this.botDifficulties[i] ??= this.options.server.botDifficulty as Difficulty;
      }
    }
    if (reshaped) this.teams = defaultTeams(count, settings.teamSize);
    if (teams !== undefined && teams.length === count && teamsBalanced(teams, settings.teamSize)) {
      this.teams = [...teams];
    }
  }

  // --------------------------------------------------------------------- match

  start(): void {
    if (this.state !== null) return;
    // Unequal teams cannot start. The host's controls never produce them, so this only
    // turns away a crafted message.
    if (!teamsBalanced(this.teams, this.settings.teamSize)) return;
    const humans = this.seats.length;
    // Fill the rest of the table with bots so a match can start under-subscribed.
    for (let i = humans; i < this.playerCount; i++) {
      this.seats.push({
        playerId: i,
        name: `Bot ${i}`,
        connection: null,
        token: this.newToken(),
        ready: true,
        bot: true,
        graceTicks: 0,
      });
    }

    // Which player, and so which island, each seat becomes — shuffled, so no seat is
    // always the one with the awkward neighbours. Seats are in join order here, and
    // until now each seat's player id was its index.
    const seed = this.rng.nextU32();
    const order = seatOrder(seed, this.seats.length);
    const players = new Array<{ name: string; isBot: boolean; team: number }>(this.seats.length);
    const difficulties = this.seats.map((_, index) => this.botDifficulties[index] ?? 'gunner');
    const hostSeat = this.seats.findIndex((seat) => seat.playerId === this.hostId);
    this.seats.forEach((seat, index) => {
      const player = order[index] as number;
      players[player] = { name: seat.name, isBot: seat.bot, team: this.teams[index] ?? index };
      seat.playerId = player;
    });
    this.hostId = this.seats[hostSeat]?.playerId ?? 0;

    this.state = createMatch({
      seed,
      // The server's rules with the host's settings over them. It travels in the
      // snapshot like any ruleset, so every client runs exactly these.
      ruleset: applySettings(this.options.ruleset, this.settings),
      terrainConfig: this.options.terrain,
      players,
    });

    this.seats.forEach((seat, index) => {
      // A seat a person holds still gets a bot, ready to cover them if they drop.
      const difficulty = difficulties[index] as Difficulty;
      this.bots.set(seat.playerId, new Bot(seat.playerId, difficulty, this.options.ai));
    });

    // Every connection learns the player it has become before the match reaches it.
    for (const seat of this.seats) this.sendWelcome(seat);
    this.broadcastRoom();
    for (const seat of this.seats) this.sendSnapshot(seat);
  }

  /** Advances the match by elapsed real time. Called by the host loop, or by tests. */
  update(elapsedMs: number): void {
    if (this.empty) this.idle += elapsedMs;
    else this.idle = 0;

    const state = this.state;
    if (state === null || state.phase === 'game_over') return;

    const tickMs = 1000 / state.ruleset.tickRateHz;
    this.accumulatorMs += Math.min(elapsedMs, 1000);
    while (this.accumulatorMs >= tickMs) {
      this.accumulatorMs -= tickMs;
      this.tick(state);
      if (this.finished) break;
    }
  }

  private tick(state: MatchState): void {
    const applied: Action[] = [];

    for (const seat of this.seats) {
      if (seat.connection !== null || seat.bot) continue;
      // A dropped player is played by a bot once the grace period lapses, so the
      // rest of the table is not held hostage by one dead connection.
      if (seat.graceTicks > 0) seat.graceTicks--;
    }

    for (const seat of this.seats) {
      const playsItself = seat.bot || (seat.connection === null && seat.graceTicks === 0);
      if (!playsItself) continue;
      const action = this.bots.get(seat.playerId)?.think(state, this.rng) ?? null;
      if (action !== null && applyAction(state, action) === null) applied.push(action);
    }

    for (const { seat, action } of this.pending) {
      if (seat.connection === null) continue;
      const rejection = applyAction(state, action);
      if (rejection === null) applied.push(action);
      else seat.connection.send({ type: 'rejected', action, reason: rejection });
    }
    this.pending = [];

    const tick = state.tick;
    step(state);
    drainEvents(state);

    const commit: ServerMessage = { type: 'commit', tick, actions: applied };
    if (tick % HASH_EVERY_TICKS === 0) commit.hash = hashMatchState(state);
    this.broadcast(commit);
  }

  // ------------------------------------------------------------------ plumbing

  private ticksFor(ms: number): number {
    return Math.ceil((ms * this.options.ruleset.tickRateHz) / 1000);
  }

  private newToken(): string {
    return this.rng.nextU32().toString(36) + this.rng.nextU32().toString(36);
  }

  private wireSeats(): WireSeat[] {
    return this.seats.map((seat) => ({
      playerId: seat.playerId,
      name: seat.name,
      isBot: seat.bot,
      connected: seat.connection !== null,
      ready: seat.ready,
    }));
  }

  private sendWelcome(seat: Seat): void {
    seat.connection?.send({
      type: 'welcome',
      protocol: PROTOCOL_VERSION,
      code: this.code,
      playerId: seat.playerId,
      token: seat.token,
      hostId: this.hostId,
    });
  }

  private sendSnapshot(seat: Seat): void {
    if (this.state === null) return;
    seat.connection?.send({ type: 'snapshot', snapshot: captureSnapshot(this.state) });
  }

  private broadcastRoom(): void {
    this.broadcast({
      type: 'room',
      code: this.code,
      seats: this.wireSeats(),
      playerCount: this.playerCount,
      bots: [...this.botDifficulties],
      settings: { ...this.settings },
      settingBounds: this.options.server.lobbySettings,
      teams: [...this.teams],
      playerLimits: { ...this.options.ruleset.players },
      hostId: this.hostId,
      started: this.started,
    });
  }

  private broadcast(message: ServerMessage): void {
    for (const seat of this.seats) seat.connection?.send(message);
  }
}
