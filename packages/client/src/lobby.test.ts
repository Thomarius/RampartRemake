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
    teams: [0, 1, 2, 3],
    playerLimits: { min: 2, max: 8 },
    seed: 42,
    hostBot: null,
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

  it('numbers every seat in the colour it will play in, as its island is labelled', () => {
    // The seed is fixed while the table is set, so the deal — and the colours — are known.
    const html = lobbyMarkup(view({ seatColours: ['#c8283c', '#2850c8', '#d8a020', '#28a050'] }));
    expect(rows(html)[0]).toContain('style="background:#c8283c">1</b>');
    expect(rows(html)[3]).toContain('style="background:#28a050">4</b>');
  });

  it('shows the map, and lets only the host draw another', () => {
    const asHost = lobbyMarkup(view());
    expect(asHost).toContain('id="map-preview"');
    expect(asHost).toContain('id="seed"');
    expect(asHost).toContain('value="42"');
    expect(asHost).toContain('id="reroll"');
    const asGuest = lobbyMarkup(view({ humanPlayer: 1, seats: [seat(0, 'Ada'), seat(1, 'Bo')] }));
    expect(asGuest).toContain('id="map-preview"');
    expect(asGuest).toContain('Map 42');
    expect(asGuest).not.toContain('id="reroll"');
  });

  it('gives each bot tier its own badge', () => {
    const html = lobbyMarkup(view({ bots: ['gunner', 'recruit', 'marshal', 'baron'] }));
    const badges = (row: string): number => (row.match(/<polyline/g) ?? []).length;
    expect(badges(rows(html)[1] as string)).toBe(1);
    expect(badges(rows(html)[2] as string)).toBe(3);
    expect(rows(html)[3]).toContain('<polygon');
  });

  it('puts the seats in one column per team', () => {
    const html = lobbyMarkup(
      view({ settings: { maxRounds: 10, teamSize: 2 }, teams: [0, 1, 1, 0] }),
    );
    const columns = [...html.matchAll(/<section class="team-column">([\s\S]*?)<\/section>/g)];
    expect(columns).toHaveLength(2);
    expect(columns[0]?.[1]).toContain('Team A');
    expect(columns[0]?.[1]).toContain('Ada');
    expect(columns[0]?.[1]).toContain('Bot 4');
    expect(columns[1]?.[1]).toContain('Bot 2');
  });

  it('marks a seat somebody has just taken', () => {
    const html = lobbyMarkup(view({ seats: [seat(0, 'Ada'), seat(1, 'Bo')], arrived: [1] }));
    expect(html).toContain('<li class="seat arrived">');
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

  it('gives the host the table controls, bounded by the rules, and guests a statement', () => {
    const host = lobbyMarkup(view({ settings: { maxRounds: 12, teamSize: 1 } }));
    expect(host).toContain('id="max-rounds"');
    expect(host).toContain('<option value="12" selected>');
    expect(host).toContain('id="team-size"');
    expect(host).toContain('id="player-count"');

    const guest = lobbyMarkup(
      view({
        humanPlayer: 1,
        seats: [seat(0, 'Ada'), seat(1, 'Bo')],
        settings: { maxRounds: 12, teamSize: 1 },
      }),
    );
    expect(guest).not.toContain('id="max-rounds"');
    expect(guest).toContain('12 rounds');
    expect(guest).toContain('Free-for-all');
  });

  it('offers only the player counts a team size allows', () => {
    const html = lobbyMarkup(
      view({ settings: { maxRounds: 10, teamSize: 2 }, teams: [0, 0, 1, 1] }),
    );
    const select = html.slice(
      html.indexOf('id="player-count"'),
      html.indexOf('</select>', html.indexOf('id="player-count"')),
    );
    const counts = [...select.matchAll(/<option value="(\d+)"/g)].map((m) => Number(m[1]));
    expect(counts).toEqual([4, 6, 8]);
  });

  it('puts every seat in a team, and lets only the host move them', () => {
    const teamed = { settings: { maxRounds: 10, teamSize: 2 }, teams: [0, 1, 0, 1] };
    const host = lobbyMarkup(view(teamed));
    expect(host.match(/class="team-select"/g)).toHaveLength(4);
    expect(host).toContain('Team B');

    const guest = lobbyMarkup(
      view({ ...teamed, humanPlayer: 1, seats: [seat(0, 'Ada'), seat(1, 'Bo')] }),
    );
    expect(guest).not.toContain('team-select');
    // Rows come in team columns now, so find Bo's by name rather than by position.
    expect(rows(guest).find((row) => row.includes('>Bo<'))).toContain('Team B');
  });

  it('will not start unequal teams, and says why', () => {
    const html = lobbyMarkup(
      view({ settings: { maxRounds: 10, teamSize: 2 }, teams: [0, 0, 0, 1] }),
    );
    expect(html).toContain('id="begin" disabled');
    expect(html).toContain('Teams must be the same size');
  });

  it('works without a server: no code, and says the table is local', () => {
    const html = lobbyMarkup(view({ code: null }));
    expect(html).not.toContain('room-code');
    expect(html).toContain('on this computer only');
  });

  it('tells a host alone that the match will run locally', () => {
    const html = lobbyMarkup(view());
    expect(html).toContain('If nobody joins, the match runs on this computer');
    // Watching is no separate button any more: it is a bot in the host's own seat.
    expect(html).not.toContain('id="watch"');
  });

  it('lets the host give their own seat to a bot, and then says they will watch', () => {
    const playing = lobbyMarkup(view());
    expect(rows(playing)[0]).toContain('id="host-bot"');
    expect(rows(playing)[0]).toContain('<option value="" selected>You play</option>');
    const watching = lobbyMarkup(view({ hostBot: 'marshal' }));
    expect(rows(watching)[0]).toContain('<option value="marshal" selected>Marshal</option>');
    expect(rows(watching)[0]).toContain('Ada watches');
    expect(watching).toContain('A bot plays your seat: you will watch.');
    // A guest sees who is playing the host's seat, and cannot change it.
    const guest = lobbyMarkup(
      view({ hostBot: 'marshal', humanPlayer: 1, seats: [seat(0, 'Ada'), seat(1, 'Bo')] }),
    );
    expect(rows(guest)[0]).not.toContain('id="host-bot"');
    expect(rows(guest)[0]).toContain('Marshal');
  });
});
