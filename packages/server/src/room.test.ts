import { defaultConfigBundle } from '@rampart/config';
import { applySnapshot, type ServerMessage } from '@rampart/protocol';
import { applyAction, createMatch, hashMatchState, step, type MatchState } from '@rampart/sim';
import { describe, expect, it } from 'vitest';

import { Room, type Connection } from './room.js';
import { RoomManager } from './rooms.js';

/**
 * A client with no socket: it receives the server's messages directly and keeps its
 * own simulation, exactly as the browser client does.
 */
class TestClient implements Connection {
  readonly received: ServerMessage[] = [];
  state: MatchState | null = null;
  playerId = -1;
  token = '';
  /** Highest tick this client has been told about; it may advance to tick + 1. */
  confirmed = -1;
  desyncs: number[] = [];

  constructor(readonly id: string) {}

  send(message: ServerMessage): void {
    this.received.push(message);
    switch (message.type) {
      case 'welcome':
        this.playerId = message.playerId;
        this.token = message.token;
        return;
      case 'snapshot': {
        // Terrain and the piece sequence are regenerated from the seed; only what
        // cannot be derived comes over the wire.
        const base = createMatch({
          seed: message.snapshot.seed,
          ruleset: message.snapshot.ruleset,
          terrainConfig: message.snapshot.terrain,
          players: message.snapshot.players.map((p) => ({ name: p.name, isBot: p.isBot })),
        });
        applySnapshot(base, message.snapshot);
        this.state = base;
        this.confirmed = message.snapshot.tick - 1;
        return;
      }
      case 'commit': {
        const state = this.state;
        if (!state) return;
        while (state.tick < message.tick) step(state);
        for (const action of message.actions) applyAction(state, action);
        step(state);
        this.confirmed = message.tick;
        if (message.hash !== undefined && hashMatchState(state) !== message.hash) {
          this.desyncs.push(message.tick);
        }
        return;
      }
      default:
        return;
    }
  }

  close(): void {}
}

function room(playerCount: number, seed = 1): Room {
  return new Room({
    code: 'TEST42',
    hostName: 'host',
    playerCount,
    ruleset: defaultConfigBundle.ruleset,
    terrain: defaultConfigBundle.terrain,
    server: defaultConfigBundle.server,
    ai: defaultConfigBundle.ai,
    seed,
  });
}

/** Runs the room forward in whole ticks. */
function run(r: Room, ticks: number): void {
  const tickMs = 1000 / defaultConfigBundle.ruleset.tickRateHz;
  for (let i = 0; i < ticks; i++) r.update(tickMs);
}

describe('room membership', () => {
  it('seats players in order and names a host', () => {
    const r = room(3);
    const a = new TestClient('a');
    const b = new TestClient('b');
    expect(r.join(a, 'Ada')).toBe(0);
    expect(r.join(b, 'Bo')).toBe(1);
    expect(a.playerId).toBe(0);
    expect(b.playerId).toBe(1);

    const roster = b.received.filter((m) => m.type === 'room').at(-1);
    expect(roster?.type === 'room' && roster.hostId).toBe(0);
    expect(roster?.type === 'room' && roster.seats).toHaveLength(2);
  });

  it('fills the empty seats with bots when the match starts', () => {
    const r = room(4);
    const a = new TestClient('a');
    r.join(a, 'Ada');
    r.start();

    const snapshot = a.received.find((m) => m.type === 'snapshot');
    expect(snapshot?.type === 'snapshot' && snapshot.snapshot.players).toHaveLength(4);
    expect(
      snapshot?.type === 'snapshot' && snapshot.snapshot.players.filter((p) => p.isBot),
    ).toHaveLength(3);
  });

  it('seats a full table of eight, which is the most the rules allow', () => {
    // The cap was raised from four and the online path was never exercised at it: the
    // protocol validated 2-8 on both sides long before a room was asked to hold eight.
    const r = room(8);
    const clients = Array.from({ length: 8 }, (_, i) => new TestClient(`c${i}`));
    clients.forEach((c, i) => expect(r.join(c, `P${i}`)).toBe(i));
    expect(new Set(clients.map((c) => c.playerId)).size).toBe(8);

    const roster = clients[7]?.received.filter((m) => m.type === 'room').at(-1);
    expect(roster?.type === 'room' && roster.seats).toHaveLength(8);
    expect(roster?.type === 'room' && roster.playerCount).toBe(8);

    // And the table is full: a ninth has nowhere to sit.
    expect(r.join(new TestClient('spare'), 'Spare')).toBeNull();
  });

  it('runs an eight-player match with every client in step', () => {
    const r = room(8, 5);
    const clients = Array.from({ length: 8 }, (_, i) => new TestClient(`c${i}`));
    for (const [i, c] of clients.entries()) r.join(c, `P${i}`);
    r.start();

    const snapshot = clients[0]?.received.find((m) => m.type === 'snapshot');
    expect(snapshot?.type === 'snapshot' && snapshot.snapshot.players).toHaveLength(8);

    run(r, 600);
    for (const client of clients) {
      expect({ id: client.id, desyncs: client.desyncs }).toEqual({ id: client.id, desyncs: [] });
      expect(client.state).not.toBeNull();
    }
  });

  it('fills eight seats with bots when only one player shows up', () => {
    const r = room(8);
    const a = new TestClient('a');
    r.join(a, 'Ada');
    r.start();

    const snapshot = a.received.find((m) => m.type === 'snapshot');
    expect(
      snapshot?.type === 'snapshot' && snapshot.snapshot.players.filter((p) => p.isBot),
    ).toHaveLength(7);
  });

  it('refuses new players once a match is under way', () => {
    const r = room(3);
    r.join(new TestClient('a'), 'Ada');
    r.start();
    expect(r.join(new TestClient('late'), 'Late')).toBeNull();
  });
});

describe('authority', () => {
  it('attributes an action to the seat that sent it, not the seat it claims', () => {
    // Otherwise a client could act for another player just by writing a different id.
    const r = room(2);
    const a = new TestClient('a');
    const b = new TestClient('b');
    r.join(a, 'Ada');
    r.join(b, 'Bo');
    r.start();
    // Past the opening announcement and into castle selection, or the action would
    // be refused for the phase before the island is ever checked.
    run(r, 200);
    expect(a.state?.phase).toBe('castle_select');

    const state = a.state;
    expect(state).not.toBeNull();
    // Ada claims to be the other player, choosing that player's castle. Which player
    // each is was shuffled at the start, so both come from what the room told them.
    const other = 1 - a.playerId;
    const theirCastle = state!.castles.find((c) => c.islandId === other + 1)!;
    r.handle(a, {
      type: 'action',
      action: { kind: 'select_castle', player: other, castleId: theirCastle.id },
    });
    run(r, 2);

    const rejected = a.received.filter((m) => m.type === 'rejected');
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected.at(-1)?.type === 'rejected' && rejected.at(-1)).toMatchObject({
      reason: 'wrong_island',
    });
  });

  it('tells a client why its action was refused', () => {
    const r = room(2);
    const a = new TestClient('a');
    r.join(a, 'Ada');
    r.join(new TestClient('b'), 'Bo');
    r.start();
    run(r, 40);

    r.handle(a, { type: 'action', action: { kind: 'fire', player: 0, x: 5, y: 5 } });
    run(r, 2);
    const rejected = a.received.filter((m) => m.type === 'rejected').at(-1);
    expect(rejected?.type === 'rejected' && rejected.reason).toBe('wrong_phase');
  });
});

describe('replicated simulation', () => {
  it('keeps every client bit-identical to the server for a whole match', () => {
    // The server never sends board state during play, only the actions it applied and
    // the tick they landed on. That is only sound because the simulation is
    // deterministic, so the periodic hash is the check that it still is.
    const r = room(3, 7);
    const a = new TestClient('a');
    const b = new TestClient('b');
    r.join(a, 'Ada');
    r.join(b, 'Bo');
    r.start();

    run(r, 4000);

    for (const client of [a, b]) {
      expect(client.state).not.toBeNull();
      expect(client.desyncs).toEqual([]);
    }
    const hashes = a.received.filter((m) => m.type === 'commit' && m.hash !== undefined);
    expect(hashes.length).toBeGreaterThan(50);
    expect(hashMatchState(a.state!)).toBe(hashMatchState(b.state!));
  });

  it('never sends the terrain, which the client regenerates from the seed', () => {
    const r = room(2);
    const a = new TestClient('a');
    r.join(a, 'Ada');
    r.start();

    const snapshot = a.received.find((m) => m.type === 'snapshot');
    expect(snapshot?.type === 'snapshot' && 'terrainLayer' in snapshot.snapshot).toBe(false);
    // The client's regenerated island map has to match what the server is playing on.
    expect(a.state!.islandId.some((v) => v > 0)).toBe(true);
    expect(a.state!.castles.length).toBeGreaterThan(0);
  });
});

describe('bot difficulty', () => {
  function lastRoom(client: TestClient) {
    const message = client.received.filter((m) => m.type === 'room').at(-1);
    if (message?.type !== 'room') throw new Error('no room message');
    return message;
  }

  it('reports a seat for every place at the table, bots included', () => {
    const r = room(4);
    const a = new TestClient('a');
    r.join(a, 'Ada');

    const roster = lastRoom(a);
    expect(roster.playerCount).toBe(4);
    expect(roster.seats).toHaveLength(1);
    // Three seats nobody has taken, each with a bot waiting behind it.
    expect(roster.bots).toHaveLength(4);
  });

  it('lets the host set the skill of each bot', () => {
    const r = room(3);
    const host = new TestClient('host');
    r.join(host, 'Ada');

    r.handle(host, { type: 'configure', bots: ['recruit', 'marshal', 'marshal'] });
    expect(lastRoom(host).bots).toEqual(['recruit', 'marshal', 'marshal']);
  });

  it('ignores a guest trying to set them', () => {
    const r = room(3);
    const host = new TestClient('host');
    const guest = new TestClient('guest');
    r.join(host, 'Ada');
    r.join(guest, 'Bo');
    const before = lastRoom(guest).bots;

    r.handle(guest, { type: 'configure', bots: ['marshal', 'marshal', 'marshal'] });
    expect(lastRoom(guest).bots).toEqual(before);
  });

  it('ignores a change once the match is under way', () => {
    const r = room(3);
    const host = new TestClient('host');
    r.join(host, 'Ada');
    r.start();
    const before = lastRoom(host).bots;

    r.handle(host, { type: 'configure', bots: ['marshal', 'marshal', 'marshal'] });
    expect(lastRoom(host).bots).toEqual(before);
  });

  it('lets the host set the round limit, and plays the match on it', () => {
    const r = room(3);
    const host = new TestClient('host');
    r.join(host, 'Ada');
    const { min, max } = defaultConfigBundle.server.lobbySettings.maxRounds;
    expect(lastRoom(host).settingBounds.maxRounds).toEqual({ min, max });

    r.handle(host, { type: 'configure', settings: { maxRounds: min } });
    expect(lastRoom(host).settings.maxRounds).toBe(min);
    // Setting one thing leaves the other alone.
    expect(lastRoom(host).bots).toHaveLength(3);

    r.start();
    run(r, 5);
    // It travels in the snapshot's ruleset, so every client runs on it.
    expect(host.state!.ruleset.scoring.maxRounds).toBe(min);
  });

  it('refuses a round limit outside the bounds, and a guest setting one at all', () => {
    const r = room(3);
    const host = new TestClient('host');
    const guest = new TestClient('guest');
    r.join(host, 'Ada');
    r.join(guest, 'Bo');
    const before = lastRoom(host).settings.maxRounds;
    const { min, max } = defaultConfigBundle.server.lobbySettings.maxRounds;

    r.handle(host, { type: 'configure', settings: { maxRounds: max + 1 } });
    r.handle(host, { type: 'configure', settings: { maxRounds: min - 1 } });
    r.handle(guest, { type: 'configure', settings: { maxRounds: min } });
    expect(lastRoom(host).settings.maxRounds).toBe(before);
  });

  it('locks the round limit once the match is under way', () => {
    const r = room(3);
    const host = new TestClient('host');
    r.join(host, 'Ada');
    r.start();
    const before = lastRoom(host).settings.maxRounds;
    const { min } = defaultConfigBundle.server.lobbySettings.maxRounds;
    r.handle(host, { type: 'configure', settings: { maxRounds: min } });
    expect(lastRoom(host).settings.maxRounds).toBe(before);
  });

  it('starts a match that plays on with the configured bots', () => {
    const r = room(3);
    const host = new TestClient('host');
    r.join(host, 'Ada');
    r.handle(host, { type: 'configure', bots: ['recruit', 'recruit', 'recruit'] });
    r.start();
    run(r, 600);

    // Bots took their seats and got on with it.
    expect(host.state).not.toBeNull();
    expect(host.state!.players.filter((p) => p.startingCastleId !== null).length).toBeGreaterThan(
      1,
    );
    expect(host.desyncs).toEqual([]);
  });
});

/** The latest room broadcast a client has received. */
function latestRoom(client: TestClient) {
  const message = client.received.filter((m) => m.type === 'room').at(-1);
  if (message?.type !== 'room') throw new Error('no room message');
  return message;
}

describe('teams at the table', () => {
  it('takes a team size, moves to a player count it allows, and seats teams in order', () => {
    const r = room(3);
    const host = new TestClient('host');
    r.join(host, 'Ada');
    r.handle(host, { type: 'configure', settings: { teamSize: 2 } });
    const shown = latestRoom(host);
    // Three cannot make two equal teams of two; four is the smallest that can.
    expect(shown.settings.teamSize).toBe(2);
    expect(shown.playerCount).toBe(4);
    expect(shown.teams).toEqual([0, 0, 1, 1]);
    expect(shown.bots).toHaveLength(4);
  });

  it('lets the host move seats between teams, but only into equal teams', () => {
    const r = room(4);
    const host = new TestClient('host');
    r.join(host, 'Ada');
    r.handle(host, { type: 'configure', settings: { teamSize: 2 } });
    r.handle(host, { type: 'configure', teams: [0, 1, 0, 1] });
    expect(latestRoom(host).teams).toEqual([0, 1, 0, 1]);
    r.handle(host, { type: 'configure', teams: [0, 0, 0, 1] });
    expect(latestRoom(host).teams).toEqual([0, 1, 0, 1]);
    // And a player count the team size does not allow is refused.
    r.handle(host, { type: 'configure', playerCount: 5 });
    expect(latestRoom(host).playerCount).toBe(4);
  });

  it('ignores a guest reshaping the table', () => {
    const r = room(4);
    const host = new TestClient('host');
    const guest = new TestClient('guest');
    r.join(host, 'Ada');
    r.join(guest, 'Bo');
    r.handle(guest, { type: 'configure', settings: { teamSize: 2 }, playerCount: 6 });
    expect(latestRoom(host).settings.teamSize).toBe(1);
    expect(latestRoom(host).playerCount).toBe(4);
  });

  it('shuffles seats onto islands at the start, tells everyone who they are, and keeps teams', () => {
    const r = room(4, 11);
    const clients = ['a', 'b'].map((id) => new TestClient(id));
    r.join(clients[0]!, 'Ada');
    r.join(clients[1]!, 'Bo');
    r.handle(clients[0]!, { type: 'configure', settings: { teamSize: 2 } });
    // Ada and Bo together, against two bots.
    r.handle(clients[0]!, { type: 'configure', teams: [0, 0, 1, 1] });
    r.start();
    run(r, 60);

    const state = clients[0]!.state!;
    const ada = state.players[clients[0]!.playerId]!;
    const bo = state.players[clients[1]!.playerId]!;
    expect(ada.name).toBe('Ada');
    expect(bo.name).toBe('Bo');
    expect(ada.team).toBe(bo.team);
    expect(state.players.filter((p) => p.team === ada.team)).toHaveLength(2);
    for (const client of clients) expect(client.desyncs).toEqual([]);
  });

  it('puts seats on different islands for different matches', () => {
    // Over a handful of rooms, the first seat is not always player 0.
    const firsts = [1, 2, 3, 4, 5, 6].map((seed) => {
      const r = room(4, seed);
      const host = new TestClient('host');
      r.join(host, 'Ada');
      r.start();
      return host.playerId;
    });
    expect(new Set(firsts).size).toBeGreaterThan(1);
  });
});

describe('disconnect and reconnect', () => {
  it('hands a dropped seat to a bot so the match does not stall', () => {
    const r = room(2, 3);
    const a = new TestClient('a');
    const b = new TestClient('b');
    r.join(a, 'Ada');
    r.join(b, 'Bo');
    r.start();
    run(r, 30);

    r.leave(b);
    run(r, 400);

    // The match kept running, and the abandoned seat was played.
    expect(a.state!.tick).toBeGreaterThan(400);
    expect(a.state!.players[1]!.startingCastleId).not.toBeNull();
  });

  it('gives a returning player their seat back, with the current board', () => {
    const r = room(2, 5);
    const a = new TestClient('a');
    const b = new TestClient('b');
    r.join(a, 'Ada');
    r.join(b, 'Bo');
    r.start();
    run(r, 200);
    const token = b.token;
    // Whichever player the start made them: islands are shuffled among the seats.
    const player = b.playerId;

    r.leave(b);
    run(r, 200);

    const returning = new TestClient('b2');
    expect(r.join(returning, 'Bo', token)).toBe(player);
    expect(returning.state).not.toBeNull();
    expect(returning.state!.tick).toBeGreaterThan(300);

    // And it catches up with the server exactly, not approximately.
    run(r, 200);
    expect(returning.desyncs).toEqual([]);
    expect(hashMatchState(returning.state!)).toBe(hashMatchState(a.state!));
  });
});

describe('room manager', () => {
  it('issues codes from an unambiguous alphabet', () => {
    const manager = new RoomManager(defaultConfigBundle, 99);
    const { codeAlphabet, codeLength } = defaultConfigBundle.server.rooms;
    for (let i = 0; i < 40; i++) {
      const created = manager.create('host', 2);
      expect(created).not.toBeNull();
      expect(created!.code).toHaveLength(codeLength);
      for (const ch of created!.code) expect(codeAlphabet).toContain(ch);
    }
  });

  it('issues a different code each time, and finds rooms by it', () => {
    const manager = new RoomManager(defaultConfigBundle, 1);
    const codes = new Set<string>();
    for (let i = 0; i < 50; i++) codes.add(manager.create('host', 2)!.code);
    expect(codes.size).toBe(50);
    for (const code of codes) expect(manager.get(code)).toBeDefined();
    expect(manager.get('NOSUCH')).toBeUndefined();
  });

  it('retires a room nobody is left in', () => {
    const manager = new RoomManager(defaultConfigBundle, 2);
    const created = manager.create('host', 2)!;
    const a = new TestClient('a');
    created.join(a, 'Ada');
    expect(manager.size).toBe(1);

    created.leave(a);
    manager.update(defaultConfigBundle.server.rooms.emptyRoomTtlMs + 1000);
    expect(manager.size).toBe(0);
  });
});

describe('the map, chosen while the table is set', () => {
  const lastRoom = (c: TestClient) => {
    const m = c.received.filter((x) => x.type === 'room').at(-1);
    if (m?.type !== 'room') throw new Error('no room message');
    return m;
  };
  const snapshotOf = (c: TestClient) => {
    const m = c.received.find((x) => x.type === 'snapshot');
    if (m?.type !== 'snapshot') throw new Error('no snapshot');
    return m.snapshot;
  };

  it('tells the table its seed before the start, and plays exactly that map', () => {
    const r = room(3, 5);
    const a = new TestClient('a');
    r.join(a, 'Ada');
    const seed = lastRoom(a).seed;
    r.start();
    expect(snapshotOf(a).seed).toBe(seed);
  });

  it('draws a different map for a different room', () => {
    const seeds = [1, 2, 3].map((n) => {
      const r = room(3, n);
      const a = new TestClient('a');
      r.join(a, 'Ada');
      return lastRoom(a).seed;
    });
    expect(new Set(seeds).size).toBe(3);
  });

  it('lets the host set the seed, and nobody else', () => {
    const r = room(3);
    const a = new TestClient('a');
    const b = new TestClient('b');
    r.join(a, 'Ada');
    r.join(b, 'Bo');
    r.handle(b, { type: 'configure', seed: 777 });
    expect(lastRoom(a).seed).not.toBe(777);
    r.handle(a, { type: 'configure', seed: 777 });
    expect(lastRoom(b).seed).toBe(777);
    r.start();
    expect(snapshotOf(b).seed).toBe(777);
  });
});

describe('a host who watches', () => {
  it('puts a bot in the host seat, which plays it while the host looks on', () => {
    const r = room(3);
    const a = new TestClient('a');
    const b = new TestClient('b');
    r.join(a, 'Ada');
    r.join(b, 'Bo');
    r.handle(a, { type: 'configure', hostBot: 'marshal' });
    const roster = a.received.filter((m) => m.type === 'room').at(-1);
    expect(roster?.type === 'room' && roster.hostBot).toBe('marshal');
    r.start();

    const snapshot = a.received.find((m) => m.type === 'snapshot');
    if (snapshot?.type !== 'snapshot') throw new Error('no snapshot');
    // The host's player is a bot now; Bo's is still a person.
    expect(snapshot.snapshot.players[a.playerId]?.isBot).toBe(true);
    expect(snapshot.snapshot.players[b.playerId]?.isBot).toBe(false);

    // Whatever the host sends as their own seat is ignored: the bot has it.
    run(r, 1);
    r.handle(a, { type: 'action', action: { kind: 'select_castle', player: 0, castleId: 0 } });
    run(r, 1);
    expect(a.received.some((m) => m.type === 'rejected')).toBe(false);
    // And the bot really plays it: the host's player chooses a castle on its own.
    run(r, 400);
    expect(a.state?.players[a.playerId]?.startingCastleId).not.toBeNull();
    expect(a.desyncs).toEqual([]);
  });

  it('keeps a returning host watching rather than handing the seat back', () => {
    const r = room(2);
    const a = new TestClient('a');
    r.join(a, 'Ada');
    r.handle(a, { type: 'configure', hostBot: 'gunner' });
    r.start();
    const back = new TestClient('a2');
    r.join(back, 'Ada', a.token);
    const snapshot = back.received.find((m) => m.type === 'snapshot');
    if (snapshot?.type !== 'snapshot') throw new Error('no snapshot');
    // Still the bot's, as the table is told.
    const roster = back.received.filter((m) => m.type === 'room').at(-1);
    const seat =
      roster?.type === 'room' ? roster.seats.find((s) => s.playerId === back.playerId) : undefined;
    expect(seat?.isBot).toBe(true);
    expect(seat?.connected).toBe(true);
  });
});
