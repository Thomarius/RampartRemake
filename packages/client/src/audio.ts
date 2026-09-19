import type { AudioManifest, MusicCue, SfxCue } from '@rampart/config';

/**
 * Sound.
 *
 * Three things shape this more than taste does.
 *
 * **Nothing here may reach the simulation.** Cue choice among variants is random, and
 * that randomness uses `Math.random` rather than the match's `Rng` — drawing from the
 * seeded stream would make two clients with different audio settings desync. Audio
 * reads the match; it never touches it.
 *
 * **A browser will not start an `AudioContext` without a user gesture.** The context is
 * therefore created lazily on the first click or keypress, and every call before that
 * is silently dropped rather than queued: a burst of cues arriving all at once the
 * moment sound switches on is worse than having missed them.
 *
 * **Missing files are silent**, which is what lets the game ship and play before a
 * single sound exists. Note that "missing" cannot be decided from the HTTP status: the
 * server answers an unknown path with the client's `index.html` and a 200, so an absent
 * cue arrives as a perfectly successful response full of HTML. What identifies it is
 * that it will not decode.
 */

/** How long one music track takes to give way to the next. */
const CROSSFADE_MS = 600;

const MUTE_KEY = 'rampart.muted';

/**
 * Shortest gap between two starts of the same cue.
 *
 * A barrage is a lot of cannons: three players with ten guns each put dozens of shots
 * in the air over a ten-second combat phase, and stacking twenty copies of one sample
 * a few milliseconds apart does not sound like twenty cannons, it sounds like
 * distortion. Dropping the ones that land on top of each other keeps the volley
 * audible as a volley.
 */
const MIN_REPEAT_MS = 60;

export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;

  /** Decoded buffers by file path. A null entry is a file known not to be there. */
  private readonly buffers = new Map<string, AudioBuffer | null>();
  /** Every path a cue may draw from, after the ones that do not exist are dropped. */
  private readonly sources = new Map<string, string[]>();

  private playing: { cue: MusicCue; source: AudioBufferSourceNode; gain: GainNode } | null = null;
  private pendingMusic: MusicCue | null = null;
  private loaded = false;
  private muted = false;
  private readonly lastStarted = new Map<string, number>();

  constructor(private readonly manifest: AudioManifest) {
    this.muted = globalThis.localStorage?.getItem(MUTE_KEY) === '1';
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /**
   * Starts the audio context, if a user gesture is in progress.
   *
   * Safe to call on every click: it does its work once, and resuming an already
   * running context is free. Loading begins here rather than at boot because there is
   * no point fetching sound for a player who never interacts.
   */
  unlock(): void {
    if (this.ctx === null) {
      const Ctor = globalThis.AudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.manifest.masterVolume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    if (!this.loaded) {
      this.loaded = true;
      void this.loadAll();
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    globalThis.localStorage?.setItem(MUTE_KEY, muted ? '1' : '0');
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(
        muted ? 0 : this.manifest.masterVolume,
        this.ctx.currentTime,
        0.05,
      );
    }
  }

  play(cue: SfxCue): void {
    const entry = this.manifest.sfx[cue];
    if (!entry || this.ctx === null || this.master === null) return;

    const now = this.ctx.currentTime * 1000;
    if (now - (this.lastStarted.get(cue) ?? -Infinity) < MIN_REPEAT_MS) return;

    const buffer = this.pick(cue);
    if (buffer === null) return;
    this.lastStarted.set(cue, now);

    const gain = this.ctx.createGain();
    gain.gain.value = entry.volume;
    gain.connect(this.master);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    source.start();
    source.addEventListener('ended', () => gain.disconnect());
  }

  /**
   * Switches the music, crossfading, and does nothing if that track is already up.
   *
   * Remembers the request when called before the context exists, so the right track is
   * running the moment sound is switched on rather than whatever the next phase change
   * happens to ask for.
   */
  music(cue: MusicCue | null): void {
    this.pendingMusic = cue;
    if (this.ctx === null || this.master === null) return;
    if (this.playing?.cue === cue) return;

    if (this.playing !== null) {
      const { source, gain } = this.playing;
      gain.gain.setTargetAtTime(0, this.ctx.currentTime, CROSSFADE_MS / 3000);
      source.stop(this.ctx.currentTime + CROSSFADE_MS / 1000);
      this.playing = null;
    }
    if (cue === null) return;

    const entry = this.manifest.music[cue];
    const buffer = this.pick(cue);
    if (!entry || buffer === null) return;

    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    gain.gain.setTargetAtTime(entry.volume, this.ctx.currentTime, CROSSFADE_MS / 3000);
    gain.connect(this.master);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = entry.loop;
    source.connect(gain);
    source.start();
    this.playing = { cue, source, gain };
  }

  /** One of the cue's surviving variants, or null when none of its files exist. */
  private pick(cue: SfxCue | MusicCue): AudioBuffer | null {
    const paths = this.sources.get(cue);
    if (paths === undefined || paths.length === 0) return null;
    // Math.random, deliberately: see the note at the top of this file.
    const path = paths[Math.floor(Math.random() * paths.length)] as string;
    return this.buffers.get(path) ?? null;
  }

  /**
   * Every file the manifest mentions, fetched in parallel and decoded.
   *
   * A cue with `variants: 3` may be supplied as `cue.ogg`, `cue.2.ogg`, `cue.3.ogg`.
   * Any of them may be absent — supplying one unnumbered file is enough — so this
   * keeps whichever turned up and forgets the rest.
   */
  private async loadAll(): Promise<void> {
    const jobs: Promise<void>[] = [];
    const add = (cue: string, file: string, variants: number): void => {
      const paths = [file];
      for (let n = 2; n <= variants; n++) {
        paths.push(file.replace(/(\.[^.]+)$/, `.${n}$1`));
      }
      jobs.push(
        Promise.all(paths.map((path) => this.load(path))).then((found) => {
          this.sources.set(
            cue,
            paths.filter((_, i) => found[i] === true),
          );
          // A track asked for before its file arrived can start now.
          if (this.pendingMusic !== null && this.playing === null) this.music(this.pendingMusic);
        }),
      );
    };

    for (const [cue, entry] of Object.entries(this.manifest.sfx)) {
      add(cue, `${this.manifest.basePath}/${entry.file}`, entry.variants ?? 1);
    }
    for (const [cue, entry] of Object.entries(this.manifest.music)) {
      add(cue, `${this.manifest.basePath}/${entry.file}`, 1);
    }
    await Promise.all(jobs);
  }

  /** True once the file is decoded and playable. */
  private async load(path: string): Promise<boolean> {
    const cached = this.buffers.get(path);
    if (cached !== undefined) return cached !== null;
    if (this.ctx === null) return false;
    try {
      const response = await fetch(path);
      if (!response.ok) throw new Error(String(response.status));
      // Decoding is what tells an absent file from a present one, since the server
      // answers a missing path with index.html and a 200. HTML does not decode.
      const buffer = await this.ctx.decodeAudioData(await response.arrayBuffer());
      this.buffers.set(path, buffer);
      return true;
    } catch {
      if (!this.manifest.missingFilesAreSilent) {
        console.warn(`audio: could not load ${path}`);
      }
      this.buffers.set(path, null);
      return false;
    }
  }
}
