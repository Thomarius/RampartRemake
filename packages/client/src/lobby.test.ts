import type { Seat } from '@rampart/protocol';
import { describe, expect, it } from 'vitest';

import { lobbyMarkup, type LobbyView } from './lobby.js';

function seat(playerId: number, name: string, connected = true): Seat {
  return { playerId, name, isBot: false, connected, ready: false };
}

function view(over: Partial<LobbyView> = {}): LobbyView {
  return {
    code: 'ABC123',
    playerCount: 4,
    hostId: 0,
    humanPlayer: 0,
    seats: [seat(0, 'Ada')],
    bots: ['gunner', 'gunner', 'gunner', 'gunner'],
    settings: { maxRounds: 10, teamSize: 1 },
    settingBounds: { maxRounds: { min: 5, max: 20 }, teamSize: { min: 1, max: 4 } },
    ...over,
  };
}

/** Seat rows, in table order. */
function rows(html: string): string[] {
  return [...html.matchAll(/<li class="seat[^"]*">([\s\S]*?)<\/li>/g)].map((m) => m[1] ?? '');
}

describe('lobby', () => {
  it('shows a row for every place at the table, taken or not', () => {
    expect(rows(lobbyMarkup(view()))).toHaveLength(4);
  });

  it('holds eight seats, which is the most the rules allow', () => {
    // The cap was raised from four and the lobby was never looked at beyond it.
    const html = lobbyMarkup(
      view({
        playerCount: 8,
        seats: [seat(0, 'Ada'), seat(3, 'Bo')],
        bots: Array.from({ length: 8 }, () => 'marshal' as const),
      }),
    );
    expect(rows(html)).toHaveLength(8);
    expect(html).toContain('2 of 8 seats taken');
    // And the two people are in their own seats, not shuffled to the front.
    expect(rows(html)[0]).toContain('Ada');
    expect(rows(html)[3]).toContain('Bo');
    expect(rows(html)[1]).toContain('Bot 2');
  });

  it('gives every seat the colour it will play in', () => {
    const html = lobbyMarkup(view({ playerCount: 8 }));
    const swatches = [...html.matchAll(/class="swatch" style="background:(#[0-9a-f]{6})"/g)].map(
      (m) => m[1],
    );
    expect(swatches).toHaveLength(8);
    expect(new Set(swatches).size).toBe(8);
  });

  it('lets only the host change the bots or start the match', () => {
    const asHost = lobbyMarkup(view({ humanPlayer: 0, hostId: 0 }));
    expect(asHost).toContain('bot-select');
    expect(asHost).toContain('id="begin"');

    const asGuest = lobbyMarkup(
      view({ humanPlayer: 1, hostId: 0, seats: [seat(0, 'Ada'), seat(1, 'Bo')] }),
    );
    expect(asGuest).not.toContain('bot-select');
    expect(asGuest).not.toContain('id="begin"');
    expect(asGuest).toContain('Waiting for the host');
  });

  it('says what a tier actually does, since its name does not', () => {
    // Seat 0 is taken by a person, so the tiers that render are seats 1 and 2.
    const html = lobbyMarkup(view({ bots: ['gunner', 'recruit', 'marshal', 'gunner'] }));
    expect(html).toContain('wanders its aim');
    expect(html).toContain('rarely misses');
    // Once each, not once per seat: two gunner seats share one line of explanation.
    expect(html.match(/finds the weak point/g)).toHaveLength(1);
  });

  it('marks your own seat, the host, and anyone who has dropped', () => {
    const html = lobbyMarkup(
      view({
        humanPlayer: 1,
        hostId: 0,
        seats: [seat(0, 'Ada'), seat(1, 'Bo'), seat(2, 'Cy', false)],
      }),
    );
    expect(rows(html)[0]).toContain('>host<');
    expect(rows(html)[1]).toContain('>you<');
    expect(rows(html)[2]).toContain('>away<');
  });

  it('offers the code for copying rather than only for reading', () => {
    const html = lobbyMarkup(view({ code: 'QX7K2M' }));
    expect(html).toContain('QX7K2M');
    expect(html).toContain('id="copy-code"');
  });

  it('escapes a name rather than letting it become markup', () => {
    // Names come from other players and the server caps their length, not their content.
    const html = lobbyMarkup(view({ seats: [seat(0, '<img src=x onerror=alert(1)>')] }));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('gives the host a round control bounded by the server, and guests a statement', () => {
    const host = lobbyMarkup(view({ settings: { maxRounds: 12, teamSize: 1 } }));
    expect(host).toContain('id="max-rounds"');
    expect(host.match(/<option value="\d+"/g)).toHaveLength(16); // 5 to 20
    expect(host).toContain('<option value="12" selected>');
    expect(host).not.toContain('<option value="4"');
    expect(host).not.toContain('<option value="21"');

    const guest = lobbyMarkup(view({ humanPlayer: 1, settings: { maxRounds: 12, teamSize: 1 } }));
    expect(guest).not.toContain('id="max-rounds"');
    expect(guest).toContain('12 rounds');
  });
});
