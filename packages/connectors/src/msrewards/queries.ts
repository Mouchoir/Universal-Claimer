/**
 * A pool of credible, varied search queries for Microsoft Rewards searches. Varying the
 * queries per run avoids a fixed, bot-like sequence (Constitution Principle VII). Kept small
 * and generic; a richer source (trends/RSS) can replace this later.
 */
const TERMS = [
  "weather forecast this weekend",
  "best pasta recipe",
  "how tall is mount everest",
  "latest space news",
  "how to tie a tie",
  "nearest coffee shop",
  "history of the internet",
  "healthy breakfast ideas",
  "current time in tokyo",
  "how do plants make oxygen",
  "top movies this year",
  "beginner running tips",
  "what is a black hole",
  "cheap flights to lisbon",
  "how to make cold brew",
  "famous impressionist painters",
  "world cup schedule",
  "best keyboard shortcuts",
  "why is the sky blue",
  "easy home workouts",
];

/** Pick a query using an injectable RNG (deterministic in tests). */
export function pickQuery(rand: () => number = Math.random): string {
  const i = Math.floor(rand() * TERMS.length) % TERMS.length;
  return TERMS[i]!;
}

export const QUERY_COUNT = TERMS.length;
