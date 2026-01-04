import { nanoid } from "nanoid";

// "KEYLE" — Wordle-style guessing for a 4-letter KEY.
// This is a game mechanic, not real-world hacking guidance.

const WORDS4 = [
  "ECHO", "RIFT", "NOVA", "BYTE", "ZERO", "DUSK", "LIME", "BOLT",
  "MINT", "CROW", "FANG", "VOID", "GRID", "NODE", "PULSE", "DARK",
  "WISP", "HALO", "MOON", "SPIN", "RUNE", "FUSE", "SALT", "KNOT"
].filter(w => w.length === 4);

const PHRASES = [
  "SIGNAL LOCKED. RECOVER THE KEY.",
  "INTERCEPT STORED. DERIVE ACCESS KEY.",
  "CHANNEL SEALED. AUTHORIZE WITH KEY."
];

function randInt(n) {
  return Math.floor(Math.random() * n);
}

function pickKey() {
  return WORDS4[randInt(WORDS4.length)];
}

export function makePuzzle() {
  const key = pickKey();
  const prompt = PHRASES[randInt(PHRASES.length)];

    console.log("PUZZLE KEY:", key);

  return {
    id: nanoid(),
    createdAt: Date.now(),
    title: "KEYLE: ACCESS KEY RECOVERY",
    prompt,
    key,              // secret
    maxTurns: 6,
    guesses: [],      // [{ guess: "ECHO", feedback: [...] }]
    solved: false
  };
}

// Returns Wordle-style feedback array for guess vs answer.
// Each element: { ch: "E", state: "correct" | "present" | "absent" }
export function scoreGuess(answer, guess) {
  const A = answer.toUpperCase();
  const G = guess.toUpperCase();

  // Count letters in answer for "present" accounting
  const counts = {};
  for (const ch of A) counts[ch] = (counts[ch] || 0) + 1;

  const fb = Array(4).fill(null).map((_, i) => ({ ch: G[i] || "", state: "absent" }));

  // Pass 1: correct positions
  for (let i = 0; i < 4; i++) {
    if (G[i] === A[i]) {
      fb[i].state = "correct";
      counts[G[i]] -= 1;
    }
  }

  // Pass 2: present letters (wrong position)
  for (let i = 0; i < 4; i++) {
    if (fb[i].state === "correct") continue;
    const ch = G[i];
    if (counts[ch] > 0) {
      fb[i].state = "present";
      counts[ch] -= 1;
    }
  }

  return fb;
}

export function checkPuzzleGuess(puzzle, guess) {
  if (puzzle.solved) {
    return { solved: true, hint: "ROUND COMPLETE.", feedback: null };
  }

  const cleaned = String(guess || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);

  if (cleaned.length !== 4) {
    return { solved: false, hint: "ENTER A 4-LETTER KEY (A–Z).", feedback: null };
  }

  const feedback = scoreGuess(puzzle.key, cleaned);
  puzzle.guesses.push({ guess: cleaned, feedback });

  const solved = cleaned === puzzle.key;
  puzzle.solved = solved;

  if (solved) {
    return { solved: true, hint: `ACCESS GRANTED. KEY="${puzzle.key}"`, feedback };
  }

  const remaining = puzzle.maxTurns - puzzle.guesses.length;
  if (remaining <= 0) {
    puzzle.solved = true; // end round (lost)
    return { solved: false, hint: `LOCKOUT. KEY WAS "${puzzle.key}"`, feedback, lockout: true };
  }

  return { solved: false, hint: `ACCESS DENIED. ${remaining} TRIES LEFT.`, feedback };
}

export function puzzleProgress(puzzle) {
  return {
    turnsUsed: puzzle.guesses.length,
    maxTurns: puzzle.maxTurns,
    solved: puzzle.solved,
    guesses: puzzle.guesses
  };
}
