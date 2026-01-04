import { nanoid } from "nanoid";

// Fictional "cipher puzzle" (simple Vigenère-like shift over A-Z and spaces preserved)
// This is a game mechanic, not real-world hacking guidance.
const PHRASES = [
  "MEET AT THE ARCHIVE AT MIDNIGHT",
  "THE KEY IS HIDDEN IN PLAIN SIGHT",
  "TRUST NO ONE EXCEPT THE SIGNAL",
  "COUNT THE LIGHTS THEN TURN LEFT",
  "SEND THE PACKAGE THROUGH THE MIRROR"
];

function randInt(n) {
  return Math.floor(Math.random() * n);
}

function randomKey() {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const len = 4 + randInt(4);
  let k = "";
  for (let i = 0; i < len; i++) k += letters[randInt(letters.length)];
  return k;
}

function enc(plaintext, key) {
  const A = "A".charCodeAt(0);
  let out = "";
  let j = 0;
  for (const ch of plaintext.toUpperCase()) {
    if (ch < "A" || ch > "Z") {
      out += ch;
      continue;
    }
    const p = ch.charCodeAt(0) - A;
    const k = key.charCodeAt(j % key.length) - A;
    const c = (p + k) % 26;
    out += String.fromCharCode(A + c);
    j++;
  }
  return out;
}

export function makePuzzle() {
  const plaintext = PHRASES[randInt(PHRASES.length)];
  const key = randomKey();
  const ciphertext = enc(plaintext, key);

  return {
    id: nanoid(),
    createdAt: Date.now(),
    title: "CRYPTOGRAM: SIGNAL INTERCEPT",
    prompt: "Guess the KEY to decode the message. (KEY is A–Z only, 4–7 chars).",
    plaintext,
    key,
    ciphertext,
    attempts: 0,
    lastGuess: null,
    solved: false
  };
}

export function checkPuzzleGuess(puzzle, guess) {
  puzzle.attempts += 1;
  puzzle.lastGuess = guess;

  const cleaned = (guess || "").toUpperCase().replace(/[^A-Z]/g, "");
  const solved = cleaned.length >= 4 && cleaned === puzzle.key;
  puzzle.solved = solved;

  // give a small hint signal: how many chars match in correct position
  const match = countPositionalMatches(cleaned, puzzle.key);

  return {
    solved,
    hint: solved
      ? `ACCESS GRANTED. Plaintext: "${puzzle.plaintext}"`
      : `ACCESS DENIED. Positional matches: ${match}/${puzzle.key.length}`
  };
}

export function puzzleProgress(puzzle) {
  return {
    attempts: puzzle.attempts,
    lastGuess: puzzle.lastGuess,
    keyLength: puzzle.key.length,
    solved: puzzle.solved
  };
}

function countPositionalMatches(a, b) {
  const n = Math.min(a.length, b.length);
  let m = 0;
  for (let i = 0; i < n; i++) if (a[i] === b[i]) m++;
  return m;
}
