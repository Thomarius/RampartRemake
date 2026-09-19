# Audio assets

Drop audio files here matching the paths declared in `config/audio.manifest.json`. This
directory is the client's public directory, so `sfx/cannon_fire.ogg` is served at
`/audio/sfx/cannon_fire.ogg` in development and in the built image alike.

- `sfx/` — short one-shot effects
- `music/` — looping phase tracks

## Format

The loader fetches the file and hands the bytes to `decodeAudioData`, so **the browser
decides what is supported, not this codebase.** Nothing inspects the extension; change
the `file` entry in `config/audio.manifest.json` and any format works. Cues may differ
from one another — music as `.mp3` and a voice line as `.wav` is fine.

| Format               | Notes                                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `.wav`               | Safe everywhere. For one-shots under a second the size hardly matters, and there is no codec artefact on a sharp transient |
| `.mp3`               | Safe everywhere, including Safari. The sane default for the music tracks                                                   |
| `.m4a` (AAC)         | Safe everywhere, better than mp3 at the same bitrate                                                                       |
| `.flac`              | Widely supported, lossless, large                                                                                          |
| `.ogg` (Vorbis/Opus) | Fine on Chrome, Firefox and Edge. **Safari is the risk** — support arrived late and older iOS will not have it             |

`.wav` and `.mp3` are verified working end to end. Those five extensions are the ones the
production server knows a content type for; another would be served as an unknown binary,
which still plays but is worth adding to the `MIME` table in `packages/server/src/main.ts`.

Cues with `"variants": N` may optionally be supplied as numbered files
(`cannon_fire.ogg`, `cannon_fire.2.ogg`, `cannon_fire.3.ogg`) and are chosen at random
to avoid repetition fatigue. A single unnumbered file is sufficient.

These files are committed rather than ignored. The deployment image is built from a clean
checkout, so an ignored cue is a cue the image would not have.

Missing files are treated as silent, so the game runs end to end with this folder empty.
Note that a missing file cannot be told from an HTTP status: the server answers an
unknown path with the client's `index.html` and a 200, so an absent cue arrives as a
successful response full of HTML. What identifies it is that it will not decode — which
also means **a corrupt or truncated file is indistinguishable from a missing one, and
will be silent rather than noisy**.

## What plays when

| Cue                              | Fires on                                                           |
| -------------------------------- | ------------------------------------------------------------------ |
| `music_menu`                     | The menu and the online lobby                                      |
| `music_admin`                    | Castle select, cannon placement, building                          |
| `music_battle`                   | Combat — started during the intermission before it, so it leads in |
| `music_victory` / `music_defeat` | Game over, according to whether you won                            |
| `voice_fire`                     | Combat begins. Spoken                                              |
| `voice_cease_fire`               | Combat ends. Spoken. Shots in the air still land                   |
| `select`                         | A castle chosen, a cannon placed, a menu button pressed            |
| `cannon_fire`                    | Any cannon firing, yours or theirs                                 |
| `shot_impact`                    | Any shot landing                                                   |
| `wall_destroyed`                 | That shot took a wall block out, rather than hitting open ground   |
| `piece_place`                    | You placed a build piece                                           |
| `piece_rotate`                   | You rotated one                                                    |
| `piece_invalid`                  | You clicked somewhere the piece or cannon cannot go                |
| `enclosure_success`              | A wall closed around a castle you were not already holding         |
| `enclosure_failed`               | You are holding less than you were last round                      |
| `player_eliminated`              | Anyone knocked out                                                 |
| `countdown_tick`                 | Each of the last three seconds of a timed phase                    |

Identical cues starting within 60ms of each other are dropped: a barrage is dozens of
shots and stacking copies of one sample sounds like distortion rather than like guns.

`M` toggles mute, and the choice is remembered.
