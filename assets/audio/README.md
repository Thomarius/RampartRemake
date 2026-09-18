# Audio assets

Drop audio files here matching the paths declared in `config/audio.manifest.json`.

- `sfx/` — short one-shot effects
- `music/` — looping phase tracks

Format: `.ogg` (Vorbis) is the default. To use a different format, change the `file`
entries in the manifest — the loader does not care about the extension.

Cues with `"variants": N` may optionally be supplied as numbered files
(`cannon_fire.ogg`, `cannon_fire.2.ogg`, `cannon_fire.3.ogg`) and are chosen at random
to avoid repetition fatigue. A single unnumbered file is sufficient.

Missing files are treated as silent, so the game runs end to end with this folder empty.
