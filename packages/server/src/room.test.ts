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
    const theirCastle = state!.castles.find((c) => c.islandId === 2)!;
    // Player 0 claims to be player 1, choosing player 1's castle.
    r.handle(a, {
      type: 'action',
      action: { kind: 'select_castle', player: 1, castleId: theirCastle.id },
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

    r.leave(b);
    run(r, 200);

    const returning = new TestClient('b2');
    expect(r.join(returning, 'Bo', token)).toBe(1);
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
