// server/src/index.js
import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import { nanoid } from "nanoid";
import http from "http";

import { rooms } from "./state.js";
import { makePuzzle, checkPuzzleGuess, puzzleProgress } from "./puzzle.js";
import { addTape, runProtectedQuery, listProtectedQueries } from "./protectedQueries.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_, res) => res.json({ ok: true }));

/**
 * Helpers
 */
function randomRoomCode() {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
function ensureRoomRound(room) {
  if (!room.scores) room.scores = { A: 0, B: 0 };
  if (!room.round) {
    room.round = {
      puzzleId: room.puzzle?.id || null,
      startedAt: Date.now(),
      winnerRole: null,
      solvedAt: null,
      lockout: false,
      attemptsByRole: { A: 0, B: 0 },
      helpByRole: { A: 0, B: 0 }
    };
  } else {
    // ensure nested objects exist (in case of older room objects)
    if (!room.round.attemptsByRole) room.round.attemptsByRole = { A: 0, B: 0 };
    if (!room.round.helpByRole) room.round.helpByRole = { A: 0, B: 0 };
    if (room.round.lockout == null) room.round.lockout = false;
  }
}
function resetRound(room) {
  room.round = {
    puzzleId: room.puzzle.id,
    startedAt: Date.now(),
    winnerRole: null,
    solvedAt: null,
    lockout: false,
    attemptsByRole: { A: 0, B: 0 },
    helpByRole: { A: 0, B: 0 }
  };
}
function computeRoundScores(room, winnerRole) {
  const attempts = room.round.attemptsByRole;
  const help = room.round.helpByRole;

  const roles = ["A", "B"];
  const out = {};

  for (const r of roles) {
    // Efficiency: fewer guesses => higher score (0..6)
    const eff = clamp(6 - (attempts[r] || 0), 0, 6);

    // Help: 2 structured help signals => full 2 points
    const helpPts = Math.min(2, ((help[r] || 0) / 2));

    // Speed: winner +2, other +1 only if they helped at least once
    let speedPts = 0;
    if (winnerRole) {
      if (r === winnerRole) speedPts = 2;
      else speedPts = (help[r] || 0) > 0 ? 1 : 0;
    }

    out[r] = Math.round((eff + helpPts + speedPts) * 10) / 10; // keep one decimal
  }

  return out;
}

/**
 * Create or join room
 */
app.post("/api/room/join", (req, res) => {
  const { roomCode, playerName, role } = req.body || {};
  if (!playerName || !role) {
    return res.status(400).json({ error: "playerName and role required" });
  }

  const code = (roomCode && String(roomCode).trim()) || randomRoomCode();

  if (!rooms.has(code)) {
    const puzzle = makePuzzle();
    const room = {
      code,
      createdAt: Date.now(),
      members: new Map(), // sessionId -> { name, role }
      chat: [], // {id, ts, from, name, text}
      tapes: new Map(), // role -> array of tape objects
      puzzle,
      analyticsLog: [], // protected query executions

      // scoring + round state
      scores: { A: 0, B: 0 },
      round: {
        puzzleId: puzzle.id,
        startedAt: Date.now(),
        winnerRole: null,
        solvedAt: null,
        lockout: false,
        attemptsByRole: { A: 0, B: 0 },
        helpByRole: { A: 0, B: 0 }
      }
    };
    rooms.set(code, room);
  }

  const room = rooms.get(code);
  ensureRoomRound(room);

  const sessionId = nanoid();
  room.members.set(sessionId, { name: playerName, role });

  res.json({
    roomCode: code,
    sessionId,
    puzzle: {
      id: room.puzzle.id,
      title: room.puzzle.title,
      prompt: room.puzzle.prompt,
      ciphertext: room.puzzle.ciphertext // if you switched to KEYLE, this may be undefined; safe to omit on UI
    },
    // surface scoring state for UI
    scores: room.scores,
    round: room.round
  });
});

/**
 * List allowed "protected queries"
 */
app.get("/api/protected-queries", (_, res) => {
  res.json({ queries: listProtectedQueries() });
});

/**
 * Upload private tape data (never shared raw)
 */
app.post("/api/tapes/upload", (req, res) => {
  const { roomCode, sessionId, items } = req.body || {};
  const room = rooms.get(roomCode);
  if (!room) return res.status(404).json({ error: "room not found" });

  const member = room.members.get(sessionId);
  if (!member) return res.status(401).json({ error: "invalid session" });

  ensureRoomRound(room);

  const safeItems = Array.isArray(items) ? items : [];
  const added = safeItems.map((t) => addTape(room, member.role, t));

  broadcast(roomCode, {
    type: "tape_uploaded",
    role: member.role,
    count: added.length
  });

  res.json({ ok: true, added: added.length });
});

/**
 * Run a protected query (clean-room mimic)
 */
app.post("/api/protected-query/run", (req, res) => {
  const { roomCode, sessionId, queryName, params } = req.body || {};
  const room = rooms.get(roomCode);
  if (!room) return res.status(404).json({ error: "room not found" });

  const member = room.members.get(sessionId);
  if (!member) return res.status(401).json({ error: "invalid session" });

  try {
    const result = runProtectedQuery(room, queryName, params);

    room.analyticsLog.push({
      id: nanoid(),
      ts: Date.now(),
      byRole: member.role,
      queryName
    });

    broadcast(roomCode, {
      type: "analytics_updated",
      byRole: member.role,
      queryName,
      result
    });

    res.json({ ok: true, result });
  } catch (e) {
    res.status(400).json({ error: e?.message || "query failed" });
  }
});

/**
 * Structured help signals (used for scoring)
 */
app.post("/api/help", (req, res) => {
  const { roomCode, sessionId, kind, payload } = req.body || {};
  const room = rooms.get(roomCode);
  if (!room) return res.status(404).json({ error: "room not found" });

  const member = room.members.get(sessionId);
  if (!member) return res.status(401).json({ error: "invalid session" });

  ensureRoomRound(room);

  room.round.helpByRole[member.role] = (room.round.helpByRole[member.role] || 0) + 1;

  broadcast(roomCode, {
    type: "help_signal",
    fromRole: member.role,
    kind: kind || "hint",
    payload: payload || null,
    helpByRole: room.round.helpByRole
  });

  res.json({ ok: true, helpByRole: room.round.helpByRole });
});

/**
 * Puzzle guess endpoint
 * - tracks attempts by role
 * - locks after winner
 * - on solve: assigns round score + total score, broadcasts winner, starts next round
 * - on lockout: broadcasts lockout + 0/10 rule, starts next round
 */
app.post("/api/puzzle/guess", (req, res) => {
  const { roomCode, sessionId, guess } = req.body || {};
  const room = rooms.get(roomCode);
  if (!room) return res.status(404).json({ error: "room not found" });

  const member = room.members.get(sessionId);
  if (!member) return res.status(401).json({ error: "invalid session" });

  ensureRoomRound(room);

  // Guard: already have a winner this round
  if (room.round.winnerRole) {
    return res.json({
      ok: true,
      solved: false,
      locked: true,
      winnerRole: room.round.winnerRole,
      progress: puzzleProgress(room.puzzle),
      hint: "ROUND LOCKED — winner already declared",
      scores: room.scores,
      round: room.round
    });
  }

  const g = String(guess || "").trim();

  // For Wordle-style puzzles, only count attempts if guess is valid length;
  // but since your checkPuzzleGuess handles validation, we count on every call here.
  room.round.attemptsByRole[member.role] = (room.round.attemptsByRole[member.role] || 0) + 1;

  const outcome = checkPuzzleGuess(room.puzzle, g);

  // Broadcast progress after each attempt
  broadcast(roomCode, {
    type: "puzzle_progress",
    progress: puzzleProgress(room.puzzle),
    solved: outcome.solved,
    byRole: member.role
  });

  // LOCKOUT case: both get 0/10 (your requirement)
  if (outcome.lockout) {
    room.round.lockout = true;

    broadcast(roomCode, {
      type: "lockout",
      roundScores: { A: 0, B: 0 },
      totalScores: room.scores, // unchanged
      attemptsByRole: room.round.attemptsByRole,
      helpByRole: room.round.helpByRole
    });

    // Start next round
    room.puzzle = makePuzzle();
    resetRound(room);

    broadcast(roomCode, {
      type: "puzzle_new",
      puzzle: {
        id: room.puzzle.id,
        title: room.puzzle.title,
        prompt: room.puzzle.prompt,
        ciphertext: room.puzzle.ciphertext
      },
      round: room.round
    });

    return res.json({
      ok: true,
      ...outcome,
      progress: puzzleProgress(room.puzzle),
      scores: room.scores,
      round: room.round
    });
  }

  // SOLVED case: compute scores + broadcast winner + start next round
  if (outcome.solved) {
    room.round.winnerRole = member.role;
    room.round.solvedAt = Date.now();

    const roundScores = computeRoundScores(room, member.role);
    room.scores.A += roundScores.A;
    room.scores.B += roundScores.B;

    broadcast(roomCode, {
      type: "winner",
      winnerRole: member.role,
      roundScores,
      totalScores: room.scores,
      attemptsByRole: room.round.attemptsByRole,
      helpByRole: room.round.helpByRole,
      solvedAt: room.round.solvedAt
    });

    // Next round
    room.puzzle = makePuzzle();
    resetRound(room);

    broadcast(roomCode, {
      type: "puzzle_new",
      puzzle: {
        id: room.puzzle.id,
        title: room.puzzle.title,
        prompt: room.puzzle.prompt,
        ciphertext: room.puzzle.ciphertext
      },
      round: room.round
    });

    return res.json({
      ok: true,
      ...outcome,
      progress: puzzleProgress(room.puzzle),
      scores: room.scores,
      round: room.round,
      roundScores
    });
  }

  // Not solved, not lockout
  res.json({
    ok: true,
    ...outcome,
    progress: puzzleProgress(room.puzzle),
    scores: room.scores,
    round: room.round
  });
});

/**
 * ---- websocket for chat + realtime updates ----
 */
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const clients = new Map(); // ws -> { roomCode, sessionId }

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (msg.type === "hello") {
      const { roomCode, sessionId } = msg;
      const room = rooms.get(roomCode);
      if (!room || !room.members.has(sessionId)) {
        ws.send(JSON.stringify({ type: "error", error: "bad room/session" }));
        return;
      }

      ensureRoomRound(room);

      clients.set(ws, { roomCode, sessionId });

      ws.send(
        JSON.stringify({
          type: "hello_ack",
          roomCode,
          puzzle: {
            id: room.puzzle.id,
            title: room.puzzle.title,
            prompt: room.puzzle.prompt,
            ciphertext: room.puzzle.ciphertext
          },
          scores: room.scores,
          round: room.round
        })
      );

      broadcast(roomCode, { type: "presence", members: [...room.members.values()] });
      return;
    }

    if (msg.type === "chat") {
      const meta = clients.get(ws);
      if (!meta) return;

      const room = rooms.get(meta.roomCode);
      if (!room) return;

      const member = room.members.get(meta.sessionId);
      if (!member) return;

      const text = String(msg.text || "").slice(0, 800);
      const chatMsg = { id: nanoid(), ts: Date.now(), from: member.role, name: member.name, text };
      room.chat.push(chatMsg);

      broadcast(meta.roomCode, { type: "chat", message: chatMsg });
      return;
    }
  });

  ws.on("close", () => {
    const meta = clients.get(ws);
    if (!meta) return;

    const room = rooms.get(meta.roomCode);
    clients.delete(ws);

    if (!room) return;
    room.members.delete(meta.sessionId);

    broadcast(meta.roomCode, { type: "presence", members: [...room.members.values()] });

    if (room.members.size === 0) rooms.delete(meta.roomCode);
  });
});

function broadcast(roomCode, payload) {
  const data = JSON.stringify(payload);
  for (const [ws, meta] of clients.entries()) {
    if (meta.roomCode === roomCode && ws.readyState === ws.OPEN) ws.send(data);
  }
}

const PORT = process.env.PORT || 8787;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`server on http://0.0.0.0:${PORT}`);
});
