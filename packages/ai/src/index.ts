// Bot logic. Bots consume the same validated action API as human players, so they
// cannot cheat by construction. See docs/PLAN.md section 8. Implemented in M5.

export const DIFFICULTIES = ['recruit', 'gunner', 'marshal'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];
