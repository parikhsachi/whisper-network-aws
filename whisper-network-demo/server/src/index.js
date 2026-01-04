// server/src/index.js
import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import { nanoid } from "nanoid";
import http from "http";

import { rooms } from "./state.js";
import { makePuzzle, checkGuess } from "./puzzle.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_, res) => res.json({ ok: true }));

/**
 * Scoring model:
 * - Each round starts at 10.0 points
 * - Each guess costs 1.0 (so maxTurns=6 means guess spam is expensive)
 * - Each tape upload costs 0.1 (a "percentage point" on a 0–10 scale)
 * - Winner bonus +1.0
 * - If lockout: both get 0/10
 *
 * You can tune later.
 */
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function randomRoomCode() {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

function ensureRoom(code) {
  if (rooms.has(code)) return rooms.get(code);

  const puzzle = makePuzzle();
  const room = {
    code,
    createdAt: Date.now(),
    members: new Map(), // sessionId -> { name, role }
    chat: [],

    puzzle,

    // PRIVATE per-role Wordle boards (never broadcast)
    boards: {
      A: { guesses: [] }, // [{guess, feedback}]
      B: { guesses: [] }
    },

    // "tapes" = shared/aggregate guess submissions (publicly visible)
    tapes: {
      A: [], // [{id, ts, guess}]
      B: []
    },

    // Round / scoring state
    round: {
      puzzleId: puzzle.id,
      startedAt: Date.now(),
      winnerRole: null,
      solvedAt: null,
      lockout: false,

      // for scoring + dashboard
      attemptsByRole: { A: 0, B: 0 },
      tapeUploadsByRole: { A: 0, B: 0 }
    },

    scores: { A: 0, B: 0 } // total
  };

  rooms.set(code, room);
  return room;
}

function resetRound(room) {
  room.puzzle = makePuzzle();
  room.boards = { A: { guesses: [] }, B: { guesses: [] } };
  room.tapes = { A: [], B: [] };
  room.round = {
    puzzleId: room.puzzle.id,
    startedAt: Date.now(),
    winnerRole: null,
    solvedAt: null,
    lockout: false,
    attemptsByRole: { A: 0, B: 0 },
    tapeUploadsByRole: { A: 0, B: 0 }
  };
}

// --- DASHBOARD (aggregates only) ---

function lettersByState(guesses) {
  const greens = new Set();
  const yellows = new Set();
  const grays = new Set();
  const greensPos = new Set(); // "A@2"
  const yellowsPos = new Set();

  for (const g of guesses) {
    const fb = g.feedback || [];
    for (let i = 0; i < fb.length; i++) {
      const ch = fb[i]?.ch;
      const st = fb[i]?.state;
      if (!ch) continue;

      if (st === "correct") {
        greens.add(ch);
        greensPos.add(`${ch}@${i}`);
      } else if (st === "present") {
        yellows.add(ch);
        yellowsPos.add(`${ch}@${i}`);
      } else {
        grays.add(ch);
      }
    }
  }

  return { greens, yellows, grays, greensPos, yellowsPos };
}

function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  const uni = new Set([...A, ...B]).size || 1;
  return inter / uni;
}

function computeSimilarity(room) {
  const A = room.boards.A.guesses;
  const B = room.boards.B.guesses;

  const a = lettersByState(A);
  const b = lettersByState(B);

  const greenLetterSim = jaccard(a.greens, b.greens);
  const yellowLetterSim = jaccard(a.yellows, b.yellows);
  const grayLetterSim = jaccard(a.grays, b.grays);

  const greenPlacementSim = jaccard(a.greensPos, b.greensPos);
  const yellowPlacementSim = jaccard(a.yellowsPos, b.yellowsPos);

  // shared uploaded tape guesses (exact match)
  const tapesA = new Set(room.tapes.A.map((t) => t.guess));
  const tapesB = new Set(room.tapes.B.map((t) => t.guess));
  const sharedTapeGuesses = [...tapesA].filter((g) => tapesB.has(g));

  return {
    greenLetterSim,
    yellowLetterSim,
    grayLetterSim,
    greenPlacementSim,
    yellowPlacementSim,
    sharedTapeGuesses,
    sharedTapeCount: sharedTapeGuesses.length
  };
}

function computeRoundScore(room, role) {
  if (room.round.lockout) return 0;

  const attempts = room.round.attemptsByRole[role] || 0;
  const tapeUploads = room.round.tapeUploadsByRole[role] || 0;

  // base 10, guesses cost 1.0 each, tape uploads cost 0.1 each
  let score = 10 - attempts * 1.0 - tapeUploads * 0.1;
  score = clamp(score, 0, 10);

  if (room.round.winnerRole === role) score = clamp(score + 1.0, 0, 10);

  // keep one decimal
  return Math.round(score * 10) / 10;
}

function dashPayload(room) {
  const sim = computeSimilarity(room);
  return {
    puzzleId: room.round.puzzleId,
    attemptsByRole: room.round.attemptsByRole,
    tapeUploadsByRole: room.round.tapeUploadsByRole,
    winnerRole: room.round.winnerRole,
    lockout: room.round.lockout,

    // ✅ total scoreboard (persistent across rounds)
    totalScores: room.scores,

    similarity: {
      greenLettersPct: Math.round(sim.greenLetterSim * 100),
      yellowLettersPct: Math.round(sim.yellowLetterSim * 100),
      grayLettersPct: Math.round(sim.grayLetterSim * 100),
      greenPlacementPct: Math.round(sim.greenPlacementSim * 100),
      yellowPlacementPct: Math.round(sim.yellowPlacementSim * 100)
    },

    sharedTapeCount: sim.sharedTapeCount,
    sharedTapeGuesses: sim.sharedTapeGuesses.slice(-5)
  };
}


// --- API ---

app.post("/api/room/join", (req, res) => {
  const { roomCode, playerName, role } = req.body || {};
  if (!playerName || !role) return res.status(400).json({ error: "playerName and role required" });

  const code = (roomCode && String(roomCode).trim()) || randomRoomCode();
  const room = ensureRoom(code);

  const sessionId = nanoid();
  room.members.set(sessionId, { name: playerName, role });

  res.json({
    roomCode: code,
    sessionId,
    puzzle: {
      id: room.puzzle.id,
      title: room.puzzle.title,
      prompt: room.puzzle.prompt,
      keyLen: room.puzzle.keyLen,
      maxTurns: room.puzzle.maxTurns
    }
  });
});

// Upload tapes: in your new logic, tapes are SHARED guesses (aggregate info).
// Each upload costs the uploader points (0.1 per tape line).
app.post("/api/tapes/upload", (req, res) => {
  const { roomCode, sessionId, items } = req.body || {};
  const room = rooms.get(roomCode);
  if (!room) return res.status(404).json({ error: "room not found" });

  const member = room.members.get(sessionId);
  if (!member) return res.status(401).json({ error: "invalid session" });

  const safeItems = Array.isArray(items) ? items : [];
  const guesses = safeItems
    .map((x) => String(x?.text || "").toUpperCase().replace(/[^A-Z]/g, "").trim())
    .filter(Boolean)
    .slice(0, 25);

  if (!guesses.length) return res.json({ ok: true, added: 0 });

  for (const g of guesses) {
    room.tapes[member.role].push({ id: nanoid(), ts: Date.now(), guess: g });
  }

  // scoring penalty
  room.round.tapeUploadsByRole[member.role] += guesses.length;

  // notify both (no raw private boards)
  broadcast(roomCode, {
    type: "tape_uploaded",
    role: member.role,
    count: guesses.length
  });

  // overlap detection (shared tape guess)
  const aSet = new Set(room.tapes.A.map((t) => t.guess));
  const bSet = new Set(room.tapes.B.map((t) => t.guess));
  const shared = [...aSet].filter((x) => bSet.has(x));
  if (shared.length) {
    const last = shared[shared.length - 1];
    broadcast(roomCode, {
      type: "tape_overlap",
      guess: last,
      sharedCount: shared.length
    });
  }

  // auto-update dashboard
  broadcast(roomCode, {
    type: "dash_update",
    dash: dashPayload(room)
  });

  res.json({ ok: true, added: guesses.length });
});

app.post("/api/puzzle/guess", (req, res) => {
  const { roomCode, sessionId, guess } = req.body || {};
  const room = rooms.get(roomCode);
  if (!room) return res.status(404).json({ error: "room not found" });

  const member = room.members.get(sessionId);
  if (!member) return res.status(401).json({ error: "invalid session" });

  // round locked?
  if (room.round.winnerRole || room.round.lockout) {
    return res.json({
      ok: true,
      locked: true,
      hint: room.round.lockout ? "LOCKOUT — round ended." : "ROUND LOCKED — winner already declared.",
      dash: dashPayload(room)
    });
  }

  const result = checkGuess(room.puzzle, guess);

  if (!result.ok) {
    return res.json({
      ok: false,
      hint: result.error,
      dash: dashPayload(room),
      progress: {
        keyLen: room.puzzle.keyLen,
        maxTurns: room.puzzle.maxTurns,
        guesses: room.boards[member.role].guesses
      }
    });
  }

  // record private guess for this role (never broadcast)
  room.boards[member.role].guesses.push({
    guess: result.cleaned,
    feedback: result.feedback,
    ts: Date.now()
  });

  room.round.attemptsByRole[member.role] += 1;

  // notify opponent that a guess happened (no board leakage)
  broadcast(roomCode, {
    type: "opponent_activity",
    role: member.role,
    kind: "guess"
  });

  // lockout?
  const turnsUsed = room.boards[member.role].guesses.length;
  const maxTurns = room.puzzle.maxTurns;

  // winner?
  if (result.solved) {
    room.round.winnerRole = member.role;
    room.round.solvedAt = Date.now();

// ✅ Winner keeps their computed score, loser gets 1 point
const winner = member.role;              // "A" or "B"
const loser = winner === "A" ? "B" : "A";

const winnerPts = computeRoundScore(room, winner);
const loserPts = 1;

const roundScores = {
  A: winner === "A" ? winnerPts : loserPts,
  B: winner === "B" ? winnerPts : loserPts
};

room.scores.A += roundScores.A;
room.scores.B += roundScores.B;


    broadcast(roomCode, {
      type: "winner",
      winnerRole: member.role,
      roundScores,
      totalScores: room.scores,
      dash: dashPayload(room)
    });

    // start next round shortly (so UI can show winner)
    setTimeout(() => {
      resetRound(room);
      broadcast(roomCode, {
        type: "puzzle_new",
        puzzle: {
          id: room.puzzle.id,
          title: room.puzzle.title,
          prompt: room.puzzle.prompt,
          keyLen: room.puzzle.keyLen,
          maxTurns: room.puzzle.maxTurns
        },
        dash: dashPayload(room)
      });
    }, 800);

    return res.json({
      ok: true,
      solved: true,
      hint: "ACCESS GRANTED.",
      progress: {
        keyLen: room.puzzle.keyLen,
        maxTurns: room.puzzle.maxTurns,
        guesses: room.boards[member.role].guesses
      },
      dash: dashPayload(room)
    });
  }

  // if either role reaches max turns and still unsolved => global lockout (both 0/10)
  const aTurns = room.boards.A.guesses.length;
  const bTurns = room.boards.B.guesses.length;
  if (aTurns >= maxTurns && bTurns >= maxTurns) {
    room.round.lockout = true;

    broadcast(roomCode, {
      type: "lockout",
      dash: dashPayload(room),
      roundScores: { A: 0, B: 0 },
      totalScores: room.scores
    });

    setTimeout(() => {
      resetRound(room);
      broadcast(roomCode, {
        type: "puzzle_new",
        puzzle: {
          id: room.puzzle.id,
          title: room.puzzle.title,
          prompt: room.puzzle.prompt,
          keyLen: room.puzzle.keyLen,
          maxTurns: room.puzzle.maxTurns
        },
        dash: dashPayload(room)
      });
    }, 800);
  }

  // update dashboard every guess
  broadcast(roomCode, {
    type: "dash_update",
    dash: dashPayload(room)
  });

  // response includes ONLY this user's private board
  return res.json({
    ok: true,
    solved: false,
    hint: "ACCESS DENIED.",
    progress: {
      keyLen: room.puzzle.keyLen,
      maxTurns: room.puzzle.maxTurns,
      guesses: room.boards[member.role].guesses
    },
    dash: dashPayload(room)
  });
});

// ---- websocket for chat + realtime updates ----
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

      clients.set(ws, { roomCode, sessionId });

      ws.send(
        JSON.stringify({
          type: "hello_ack",
          roomCode,
          puzzle: {
            id: room.puzzle.id,
            title: room.puzzle.title,
            prompt: room.puzzle.prompt,
            keyLen: room.puzzle.keyLen,
            maxTurns: room.puzzle.maxTurns
          },
          dash: dashPayload(room)
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
