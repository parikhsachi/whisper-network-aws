import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import { nanoid } from "nanoid";
import http from "http";

import { rooms } from "./state.js";
import {
  makePuzzle,
  checkPuzzleGuess,
  puzzleProgress
} from "./puzzle.js";

import {
  addTape,
  runProtectedQuery,
  listProtectedQueries
} from "./protectedQueries.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_, res) => res.json({ ok: true }));

// Create or join room
app.post("/api/room/join", (req, res) => {
  const { roomCode, playerName, role } = req.body || {};
  if (!playerName || !role) return res.status(400).json({ error: "playerName and role required" });

  const code = (roomCode && String(roomCode).trim()) || randomRoomCode();
  if (!rooms.has(code)) {
    rooms.set(code, {
      code,
      createdAt: Date.now(),
      members: new Map(), // sessionId -> { name, role }
      chat: [], // {id, ts, from, text}
      tapes: new Map(), // role -> array of tape objects
      puzzle: makePuzzle(),
      analyticsLog: [] // protected query executions
    });
  }

  const room = rooms.get(code);

  // one member per role is simplest for demo (allow multiple if you want)
  // We'll allow multiple sessions, but role is stored per session.
  const sessionId = nanoid();
  room.members.set(sessionId, { name: playerName, role });

  res.json({
    roomCode: code,
    sessionId,
    puzzle: {
      id: room.puzzle.id,
      title: room.puzzle.title,
      prompt: room.puzzle.prompt,
      ciphertext: room.puzzle.ciphertext
    }
  });
});

// List allowed "protected queries"
app.get("/api/protected-queries", (_, res) => {
  res.json({ queries: listProtectedQueries() });
});

// Upload private tape data (never shared raw)
app.post("/api/tapes/upload", (req, res) => {
  const { roomCode, sessionId, items } = req.body || {};
  const room = rooms.get(roomCode);
  if (!room) return res.status(404).json({ error: "room not found" });
  const member = room.members.get(sessionId);
  if (!member) return res.status(401).json({ error: "invalid session" });

  const safeItems = Array.isArray(items) ? items : [];
  const added = safeItems.map((t) => addTape(room, member.role, t));

  // Notify room (no raw data)
  broadcast(roomCode, {
    type: "tape_uploaded",
    role: member.role,
    count: added.length
  });

  res.json({ ok: true, added: added.length });
});

// Run a protected query (clean-room mimic)
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
    res.status(400).json({ error: e.message || "query failed" });
  }
});

// Puzzle guess endpoint (fictional cipher puzzle)
app.post("/api/puzzle/guess", (req, res) => {
  const { roomCode, sessionId, guess } = req.body || {};
  const room = rooms.get(roomCode);
  if (!room) return res.status(404).json({ error: "room not found" });
  const member = room.members.get(sessionId);
  if (!member) return res.status(401).json({ error: "invalid session" });

  const g = String(guess || "").trim();
  const outcome = checkPuzzleGuess(room.puzzle, g);

  broadcast(roomCode, {
    type: "puzzle_progress",
    progress: puzzleProgress(room.puzzle),
    solved: outcome.solved,
    byRole: member.role
  });

  if (outcome.solved) {
    broadcast(roomCode, {
      type: "system",
      text: `Puzzle solved by ${member.role}. New puzzle generated.`
    });
    room.puzzle = makePuzzle();
    broadcast(roomCode, {
      type: "puzzle_new",
      puzzle: {
        id: room.puzzle.id,
        title: room.puzzle.title,
        prompt: room.puzzle.prompt,
        ciphertext: room.puzzle.ciphertext
      }
    });
  }

  res.json({ ok: true, ...outcome, progress: puzzleProgress(room.puzzle) });
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
      ws.send(JSON.stringify({
        type: "hello_ack",
        roomCode,
        puzzle: {
          id: room.puzzle.id,
          title: room.puzzle.title,
          prompt: room.puzzle.prompt,
          ciphertext: room.puzzle.ciphertext
        }
      }));
      broadcast(roomCode, { type: "presence", members: [...room.members.values()] });
      return;
    }

    // Chat message
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

    // Optional: cleanup empty rooms
    if (room.members.size === 0) rooms.delete(meta.roomCode);
  });
});

function broadcast(roomCode, payload) {
  const data = JSON.stringify(payload);
  for (const [ws, meta] of clients.entries()) {
    if (meta.roomCode === roomCode && ws.readyState === ws.OPEN) ws.send(data);
  }
}

function randomRoomCode() {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

const PORT = process.env.PORT || 8787;
server.listen(PORT, () => {
  console.log(`server on http://localhost:${PORT}`);
});
