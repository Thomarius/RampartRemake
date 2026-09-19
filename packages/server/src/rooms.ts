import type { ConfigBundle } from '@rampart/config';
import { Rng } from '@rampart/sim';

import { Room } from './room.js';

/**
 * Owns the live rooms and hands out their codes.
 *
 * Codes are drawn from an alphabet with no ambiguous glyphs, because the entire
 * onboarding story is one player reading a code to another.
 */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly rng: Rng;

  constructor(
    private readonly config: ConfigBundle,
    seed = Date.now() >>> 0,
  ) {
    this.rng = new Rng(seed);
  }

  get size(): number {
    return this.rooms.size;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code.toUpperCase());
  }

  create(hostName: string, playerCount: number): Room | null {
    if (this.rooms.size >= this.config.server.rooms.maxConcurrent) return null;
    const room = new Room({
      code: this.newCode(),
      hostName,
      playerCount,
      ruleset: this.config.ruleset,
      terrain: this.config.terrain,
      server: this.config.server,
      ai: this.config.ai,
      seed: this.rng.nextU32(),
    });
    this.rooms.set(room.code, room);
    return room;
  }

  /** Advances every room and retires the ones nobody is left in. */
  update(elapsedMs: number): void {
    for (const [code, room] of this.rooms) {
      room.update(elapsedMs);
      const ttl = room.started
        ? this.config.server.rooms.abandonedMatchTtlMs
        : this.config.server.rooms.emptyRoomTtlMs;
      if (room.empty && room.idleMs > ttl) this.rooms.delete(code);
    }
  }

  private newCode(): string {
    const { codeLength, codeAlphabet } = this.config.server.rooms;
    for (let attempt = 0; attempt < 64; attempt++) {
      let code = '';
      for (let i = 0; i < codeLength; i++) {
        code += codeAlphabet[this.rng.nextInt(codeAlphabet.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('could not find an unused room code');
  }
}
