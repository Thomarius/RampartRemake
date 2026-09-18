import {
  PROTOCOL_VERSION,
  decodeServerMessage,
  encode,
  type ClientMessage,
  type ServerMessage,
} from '@rampart/protocol';

export type ConnectionState = 'connecting' | 'open' | 'closed';

/**
 * The client's end of the wire.
 *
 * Reconnection is the point of the token: a dropped player's seat is played by a bot
 * until they come back, and presenting the token reclaims it rather than taking a new
 * one. The token is kept in session storage so a refresh does not cost the seat.
 */
export class ServerConnection {
  private socket: WebSocket | null = null;
  private queue: ClientMessage[] = [];
  private listeners: ((message: ServerMessage) => void)[] = [];

  state: ConnectionState = 'connecting';
  latencyMs = 0;
  private pingedAt = 0;

  constructor(private readonly url: string) {}

  static defaultUrl(): string {
    const secure = globalThis.location.protocol === 'https:';
    return `${secure ? 'wss' : 'ws'}://${globalThis.location.host}`;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;

      socket.addEventListener('open', () => {
        this.state = 'open';
        for (const message of this.queue) socket.send(encode(message));
        this.queue = [];
        resolve();
      });
      socket.addEventListener('close', () => {
        this.state = 'closed';
      });
      socket.addEventListener('error', () => {
        if (this.state === 'connecting') reject(new Error(`cannot reach ${this.url}`));
      });
      socket.addEventListener('message', (event: MessageEvent) => {
        const message = decodeServerMessage(String(event.data));
        if (message === null) return;
        if (message.type === 'pong') {
          // Round trip measured against our own clock, so no clock agreement is
          // needed — the simulation is paced by the server's commits, not by time.
          this.latencyMs = Math.round(performance.now() - message.t);
          return;
        }
        for (const listener of this.listeners) listener(message);
      });
    });
  }

  onMessage(listener: (message: ServerMessage) => void): void {
    this.listeners.push(listener);
  }

  send(message: ClientMessage): void {
    if (this.socket && this.state === 'open') this.socket.send(encode(message));
    else this.queue.push(message);
  }

  createRoom(name: string, players: number): void {
    this.send({ type: 'create', protocol: PROTOCOL_VERSION, name, players });
  }

  joinRoom(name: string, code: string, token?: string): void {
    this.send({
      type: 'join',
      protocol: PROTOCOL_VERSION,
      name,
      code: code.toUpperCase(),
      ...(token === undefined ? {} : { token }),
    });
  }

  ping(): void {
    this.pingedAt = performance.now();
    this.send({ type: 'ping', t: this.pingedAt });
  }

  close(): void {
    this.socket?.close();
    this.state = 'closed';
  }
}
