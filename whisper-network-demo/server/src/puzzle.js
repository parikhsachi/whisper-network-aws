// server/src/puzzle.js
import { nanoid } from "nanoid";

// KEYLE: Wordle-style key recovery (demo-safe).
// Private boards per role; only aggregates are shared via "tapes".

const KEY_LEN = 5; // change to 6 later if you want
const MAX_TURNS = 3;

// Keep this list small for demo. You can expand later.
const WORDS = [
  "CRYPT",
  "AGENT",
  "TRACE",
  "PROXY",
].filter((w) => w.length === KEY_LEN);

const PROMPTS = [
  "Recover the access key. Private boards. Aggregates only.",
  "Two agents race to recover the key. Share only via tapes.",
  "Upload tapes to share guesses (costs points). First solver wins."
];

function randInt(n) {
  return Math.floor(Math.random() * n);
}

function pickKey() {
  return WORDS[randInt(WORDS.length)];
}

export function makePuzzle() {
  const key = pickKey();
    console.log("PUZZLE KEY:", key);

  return {
    id: nanoid(),
    createdAt: Date.now(),
    title: "KEYLE: ACCESS KEY RECOVERY",
    prompt: PROMPTS[randInt(PROMPTS.length)],
    key, // secret (server-side only)
    keyLen: KEY_LEN,
    maxTurns: MAX_TURNS
  };
}

export function normalizeGuess(guess, keyLen) {
  return String(guess || "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, keyLen);
}

export function scoreGuess(answer, guess) {
  const A = answer.toUpperCase();
  const G = guess.toUpperCase();

  const counts = {};
  for (const ch of A) counts[ch] = (counts[ch] || 0) + 1;

  const fb = Array(A.length)
    .fill(null)
    .map((_, i) => ({ ch: G[i] || "", state: "absent" }));

  // correct positions
  for (let i = 0; i < A.length; i++) {
    if (G[i] === A[i]) {
      fb[i].state = "correct";
      counts[G[i]] -= 1;
    }
  }

  // present letters
  for (let i = 0; i < A.length; i++) {
    if (fb[i].state === "correct") continue;
    const ch = G[i];
    if (counts[ch] > 0) {
      fb[i].state = "present";
      counts[ch] -= 1;
    }
  }

  return fb;
}

export function checkGuess(puzzle, guessRaw) {
  const cleaned = normalizeGuess(guessRaw, puzzle.keyLen);

  if (cleaned.length !== puzzle.keyLen) {
    return {
      ok: false,
      error: `Enter a ${puzzle.keyLen}-letter guess (A–Z).`,
      cleaned
    };
  }

  const feedback = scoreGuess(puzzle.key, cleaned);
  const solved = cleaned === puzzle.key;

  return {
    ok: true,
    cleaned,
    feedback,
    solved
  };
}
