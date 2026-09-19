import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { loadConfigBundle } from '@rampart/config/node';
import {
  PROTOCOL_VERSION,
  decodeClientMessage,
  encode,
  type ServerMessage,
} from '@rampart/protocol';
import { WebSocketServer, type WebSocket } from 'ws';

import { repoRoot } from './paths.js';
import type { Connection, Room } from './room.js';
import { RoomManager } from './rooms.js';

const bundle = loadConfigBundle(repoRoot);
const rooms = new RoomManager(bundle);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  // Audio cues may be supplied in any format the browser can decode, so the manifest
  // names whatever file exists and this has to be able to describe it. `decodeAudioData`
  // reads the bytes and ignores the content type, so getting one of these wrong is not
  // fatal — but serving a sound as an unknown binary blob confuses caches and anything
  // else that looks at the response before the game does.
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
};

/** Serves the built client, so one process is the whole deployment. */
const clientDist = join(repoRoot, 'packages', 'client', 'dist');

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const rel = normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
  let file = join(clientDist, rel);
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(clientDist, 'index.html');

  if (!existsSync(file)) {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('client not built — run: npm run build -w @rampart/client');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

const http = createServer(serveStatic);
const wss = new WebSocketServer({ server: http });

let nextConnectionId = 0;

/** Which room each connection is in, so later messages can be routed without a scan. */
const joined = new Map<string, Room>();

wss.on('connection', (socket: WebSocket) => {
  const id = `c${nextConnectionId++}`;
  let messagesThisSecond = 0;
  let windowStart = Date.now();

  const connection: Connection = {
    id,
    send(message: ServerMessage) {
      if (socket.readyState === socket.OPEN) socket.send(encode(message));
    },
    close(reason: string) {
      connection.send({ type: 'error', code: 'closed', message: reason });
      socket.close();
    },
  };

  socket.on('message', (raw: Buffer | string) => {
    const now = Date.now();
    if (now - windowStart > 1000) {
      windowStart = now;
      messagesThisSecond = 0;
    }
    if (++messagesThisSecond > bundle.server.limits.maxMessagesPerSecond) return;

    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    if (text.length > bundle.server.limits.maxMessageBytes) return;

    const message = decodeClientMessage(text);
    if (message === null) {
      connection.send({ type: 'error', code: 'bad_message', message: 'unparseable message' });
      return;
    }

    if (message.type === 'create' || message.type === 'join') {
      if (message.protocol !== PROTOCOL_VERSION) {
        connection.close(`protocol ${message.protocol} is not ${PROTOCOL_VERSION}`);
        return;
      }
    }

    if (message.type === 'create') {
      const room = rooms.create(message.name, message.players);
      if (room === null) {
        connection.send({ type: 'error', code: 'no_capacity', message: 'server is full' });
        return;
      }
      room.join(connection, message.name);
      joined.set(connection.id, room);
      return;
    }

    if (message.type === 'join') {
      const room = rooms.get(message.code);
      if (room === undefined) {
        connection.send({ type: 'error', code: 'no_room', message: 'no room with that code' });
        return;
      }
      if (room.join(connection, message.name, message.token) === null) {
        connection.send({ type: 'error', code: 'room_full', message: 'that room is full' });
        return;
      }
      joined.set(connection.id, room);
      return;
    }

    // Everything else is only meaningful inside a room this connection is in.
    const room = joined.get(connection.id);
    if (room === undefined) {
      connection.send({ type: 'error', code: 'no_room', message: 'join a room first' });
      return;
    }
    room.handle(connection, message);
  });

  const forget = (): void => {
    joined.get(connection.id)?.leave(connection);
    joined.delete(connection.id);
  };
  socket.on('close', forget);
  socket.on('error', forget);
});

const TICK_MS = 1000 / bundle.ruleset.tickRateHz;
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  rooms.update(now - last);
  last = now;
}, TICK_MS);

/**
 * Where to listen, which is the one thing the environment is allowed to say.
 *
 * Every game rule lives in `config/*.json` behind a strict schema and is reachable
 * from nowhere else — a rule that could be changed by an environment variable is a
 * rule two clients could disagree about, which is a desync rather than a setting. A
 * port is not a rule: it is where this process binds, and hosts like Fly and Railway
 * hand it to us in `$PORT` rather than letting us choose. So these two read the
 * environment first and the config file second, and nothing else does.
 */
const port = Number(process.env['PORT'] ?? bundle.server.port);
const host = process.env['HOST'] ?? bundle.server.host;
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`PORT must be a port number, got ${JSON.stringify(process.env['PORT'])}`);
  process.exit(1);
}

http.listen(port, host, () => {
  console.error(
    `rampart server on http://${host}:${port} ` +
      `(protocol ${PROTOCOL_VERSION}, ${bundle.ruleset.tickRateHz}Hz)`,
  );
});
