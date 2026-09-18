// The deterministic game core. No DOM, no Node, no I/O — everything else in the
// repository is I/O around this package.
//
// Invariant: (seed, ruleset, ordered input log) -> identical final state hash.
// See docs/PLAN.md section 5. Implemented in M1.

export type { Ruleset, TerrainConfig, CraterPattern } from '@rampart/config';
