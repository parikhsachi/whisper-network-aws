import React, { useEffect, useMemo, useRef, useState } from "react";

const API = {
  join: async (roomCode: string, playerName: string, role: "A" | "B") => {
    const res = await fetch("/api/room/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomCode: roomCode || null, playerName, role })
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  uploadTapes: async (roomCode: string, sessionId: string, items: { text: string; ts?: number }[]) => {
    const res = await fetch("/api/tapes/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomCode, sessionId, items })
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  puzzleGuess: async (roomCode: string, sessionId: string, guess: string) => {
    const res = await fetch("/api/puzzle/guess", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomCode, sessionId, guess })
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }
};

function nowTime(ts: number) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function getQueryParams() {
  const p = new URLSearchParams(window.location.search);
  return {
    room: p.get("room") || "",
    role: (p.get("role") === "B" ? "B" : "A") as "A" | "B",
    name: p.get("name") || ""
  };
}

export default function App() {
  const [sessionId, setSessionId] = useState("");
  const [presence, setPresence] = useState<{ name: string; role: string }[]>([]);
  const [chat, setChat] = useState<any[]>([]);
  const [statusLine, setStatusLine] = useState("SYSTEM: idle");

  const [puzzle, setPuzzle] = useState<any>(null);
  const [puzzleGuess, setPuzzleGuess] = useState("");
  const [puzzleHint, setPuzzleHint] = useState("");
  const [myProgress, setMyProgress] = useState<any>(null); // PRIVATE board (only mine)

  const [tapeText, setTapeText] = useState("");
  const [tapeUploads, setTapeUploads] = useState<{ role: string; count: number; ts: number }[]>([]);
  const [stage, setStage] = useState<"join" | "ops">("join");

  const [roomCode, setRoomCode] = useState("");
  const [playerName, setPlayerName] = useState("");
  const [role, setRole] = useState<"A" | "B">("A");

  // DASHBOARD (aggregates)
  const [dash, setDash] = useState<any>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const connected = stage === "ops" && wsRef.current && wsRef.current.readyState === 1;

  useEffect(() => {
    const qp = getQueryParams();
    if (qp.room) setRoomCode(qp.room);
    if (qp.role) setRole(qp.role);
    if (qp.name) setPlayerName(qp.name);
  }, []);

  useEffect(() => {
    const qp = getQueryParams();
    if (stage === "join" && qp.room && qp.role && qp.name) {
      join();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  const join = async () => {
    setStatusLine("SYSTEM: joining collaboration...");
    const data = await API.join(roomCode.trim(), playerName.trim() || "agent", role);

    setRoomCode(data.roomCode);
    setSessionId(data.sessionId);
    setPuzzle(data.puzzle);
    setStage("ops");

    const shareUrl =
      `${window.location.origin}/` +
      `?room=${encodeURIComponent(data.roomCode)}` +
      `&role=${encodeURIComponent(role)}` +
      `&name=${encodeURIComponent(playerName)}`;

    window.history.replaceState({}, "", shareUrl);
    setStatusLine(`SYSTEM: connected to COLLAB ${data.roomCode} as ${role}`);

    const WS_URL =
      (window.location.protocol === "https:" ? "wss://" : "ws://") +
      window.location.hostname +
      ":8787";

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "hello", roomCode: data.roomCode, sessionId: data.sessionId }));
    };

    ws.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }

      if (msg.type === "hello_ack") {
        setPuzzle(msg.puzzle);
        if (msg.dash) setDash(msg.dash);
      }

      if (msg.type === "presence") {
        setPresence(msg.members || []);
      }

      if (msg.type === "chat") {
        setChat((c) => c.concat([msg.message]));
      }

      if (msg.type === "tape_uploaded") {
        setTapeUploads((x) => x.concat([{ role: msg.role, count: msg.count, ts: Date.now() }]));
        setStatusLine(`SYSTEM: Agent ${msg.role} uploaded ${msg.count} tapes (shared aggregate).`);
      }

      if (msg.type === "tape_overlap") {
        setStatusLine(`CONVERGENCE: both agents uploaded "${msg.guess}" (sharedCount=${msg.sharedCount})`);
      }

      if (msg.type === "opponent_activity") {
        const other = msg.role === "A" ? "A" : "B";
        setStatusLine(`SIGNAL: Agent ${other} submitted a guess (private board).`);
      }

      if (msg.type === "dash_update") {
        setDash(msg.dash);
      }

      if (msg.type === "winner") {
        setDash(msg.dash || null);
        setStatusLine(`WINNER: Agent ${msg.winnerRole} | Round A:${msg.roundScores?.A} B:${msg.roundScores?.B}`);
      }

      if (msg.type === "lockout") {
        setDash(msg.dash || null);
        setStatusLine("LOCKOUT — both agents score 0/10");
      }

      if (msg.type === "puzzle_new") {
        setPuzzle(msg.puzzle);
        setPuzzleHint("");
        setPuzzleGuess("");
        setMyProgress(null);
        setDash(msg.dash || null);
        setStatusLine("SYSTEM: new round initialized.");
      }
    };

    ws.onclose = () => setStatusLine("SYSTEM: disconnected");
  };

  const sendChat = (text: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: "chat", text }));
  };

  // Tapes now mean: shared guesses you choose to publish (costs points).
  const uploadTape = async () => {
    const lines = tapeText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 25)
      .map((text) => ({ text, ts: Date.now() }));

    if (!lines.length) return;

    await API.uploadTapes(roomCode, sessionId, lines);
    setTapeText("");
  };

  const guessKey = async () => {
    const out = await API.puzzleGuess(roomCode, sessionId, puzzleGuess);
    if (out.hint) setPuzzleHint(out.hint);
    if (out.progress) setMyProgress(out.progress);
    if (out.dash) setDash(out.dash);
  };

  const headerMeta = useMemo(() => {
    const dt = new Date();
    const mon = dt.toLocaleString("en-US", { month: "short" });
    const day = String(dt.getDate()).padStart(2, "0");
    const hh = dt.getHours();
    const mm = String(dt.getMinutes()).padStart(2, "0");
    const ampm = hh >= 12 ? "PM" : "AM";
    const hr12 = ((hh + 11) % 12) + 1;
    return { date: `${mon} ${day}`, time: `${hr12}:${mm} ${ampm}` };
  }, [stage]);

  if (stage === "join") {
    return (
      <div className="bg">
        <div className="grid">
          <Window title="WHISPER NETWORK :: ACCESS" right={`${headerMeta.date}  ${headerMeta.time}`}>
            <div className="join">
              <div className="row">
                <label>ROOM CODE</label>
                <input value={roomCode} onChange={(e) => setRoomCode(e.target.value)} placeholder="" />
              </div>

              <div className="row">
                <label>HANDLE</label>
                <input value={playerName} onChange={(e) => setPlayerName(e.target.value)} placeholder="agent name" />
              </div>

              <div className="row">
                <label>ROLE</label>
                <div className="seg">
                  <button className={role === "A" ? "on" : ""} onClick={() => setRole("A")}>
                    A
                  </button>
                  <button className={role === "B" ? "on" : ""} onClick={() => setRole("B")}>
                    B
                  </button>
                </div>
              </div>

              <div className="row">
                <button className="primary" onClick={join}>
                  ENTER COLLAB
                </button>
              </div>

              <div className="banner">
                <div className="bannerText">{">> You and the other agent must share signals to crack the code."}</div>
                <div className="bannerText">{">> First to solve gets the higher score, but both get locked out if it isn't found."}</div>
                <div className="bannerText">{">> You may publish guesses as tapes — but it lowers your score."}</div>
                <div className="bannerText">{">> Clean Rooms analytics dashboard shows similarity in guesses and statistics."}</div>
              </div>
            </div>
          </Window>
        </div>
      </div>
    );
  }

  return (
    <div className="bg">
      <div className="topbar">
        <div className="brand">WHISPER NETWORK</div>

        <div className="identity">
          <div className={`agentBadge agent-${role}`}>
            <div className="agentName">
              AGENT {role}:{playerName}
            </div>
          </div>

          <div className="meta">
            <span className="pill">ROOM: {roomCode}</span>
            <span className="pill">{connected ? "LINK: ONLINE" : "LINK: OFFLINE"}</span>
          </div>
        </div>
      </div>

      <div className="layout">
        <div className="col">
          <Window title="ENCRYPTOR" right="PRIVATE BOARD">
            <div className="puzzle">
              <div className="p-title">{puzzle?.title}</div>
              <div className="p-prompt dim">{puzzle?.prompt}</div>

              <div className="cipher">
                <div className="label">YOUR KEY GRID</div>
                <KeyGrid
                  guesses={myProgress?.guesses || []}
                  maxTurns={puzzle?.maxTurns || myProgress?.maxTurns || 6}
                  keyLen={puzzle?.keyLen || myProgress?.keyLen || 5}
                />
              </div>

              <div className="row2">
                <input
                  value={puzzleGuess}
                  onChange={(e) => setPuzzleGuess(e.target.value)}
                  placeholder={`guess ${puzzle?.keyLen || 5} letters (A-Z)`}
                />
                <button onClick={guessKey}>EXECUTE</button>
              </div>

              <div className="hintline">{puzzleHint}</div>

              <div className="dim small">
                Turns used: {myProgress?.guesses?.length || 0} / {puzzle?.maxTurns || 6}
              </div>
            </div>
          </Window>

          <Window title="UPLOAD" right="SHARED TAPES (COSTS SCORE)">
            <div className="upload">
              <div className="dim small">
                Paste guesses you want to publish as shared aggregates (1 per line). Each line costs you 0.1 points.
              </div>
              <textarea
                value={tapeText}
                onChange={(e) => setTapeText(e.target.value)}
                placeholder={`e.g.\nBOOKS\nCLOUD\nTRACE\n`}
              />
              <div className="row2">
                <button onClick={uploadTape}>UPLOAD TAPES</button>
                <div className="dim small">
                  Recent:{" "}
                  {tapeUploads.slice(-1)[0]
                    ? `${tapeUploads.slice(-1)[0].role}+${tapeUploads.slice(-1)[0].count}`
                    : "—"}
                </div>
              </div>
            </div>
          </Window>
        </div>

        <div className="col">
          <Window title="TRANSFER" right="CHAT LINK">
            <ChatPanel chat={chat} onSend={sendChat} role={role} />
          </Window>

          <Window title="RECEIVER" right="AUTO ANALYTICS DASH">
            <Dashboard dash={dash} />
          </Window>

          <Window title="TERMINAL" right="STATUS">
            <div className="terminal">
              <div className="line">{statusLine}</div>
              <div className="line dim">
                presence:{" "}
                {presence.length
                  ? presence.map((m, i) => (
                      <span key={i}>
                        [{m.role}:{m.name}]{" "}
                      </span>
                    ))
                  : "—"}
              </div>
              <div className="line dim">
                tip: you can’t see the other board. publish guesses as tapes if you want convergence signals.
              </div>
            </div>
          </Window>
        </div>
      </div>
    </div>
  );
}

function Window(props: { title: string; right?: string; children: any }) {
  return (
    <div className="win">
      <div className="winbar">
        <div className="wintitle">{props.title}</div>
        <div className="winright">{props.right || ""}</div>
      </div>
      <div className="winbody">{props.children}</div>
    </div>
  );
}

function ChatPanel(props: { chat: any[]; onSend: (t: string) => void; role: string }) {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [props.chat.length]);

  return (
    <div className="chat">
      <div className="chatlist" ref={listRef}>
        {props.chat.map((m) => (
          <div key={m.id} className={`msg ${m.from === props.role ? "me" : ""}`}>
            <div className="meta">
              <span className="from">{m.from}</span>
              <span className="dim">{m.name}</span>
              <span className="dim">{nowTime(m.ts)}</span>
            </div>
            <div className="text">{m.text}</div>
          </div>
        ))}
      </div>

      <div className="chatbox">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="message…"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              props.onSend(draft);
              setDraft("");
            }
          }}
        />
        <button
          onClick={() => {
            props.onSend(draft);
            setDraft("");
          }}
        >
          SEND
        </button>
      </div>
    </div>
  );
}

function Dashboard(props: { dash: any }) {
  const d = props.dash;

  return (
    <div className="dash">
      <div className="dashgrid">
        <div className="card">
          <div className="cardtitle">SIMILARITY (AGG)</div>
          {d ? (
            <div className="rows">
              <div className="row3"><span>Green letters</span><span className="dim">{d.similarity.greenLettersPct}%</span></div>
              <div className="row3"><span>Yellow letters</span><span className="dim">{d.similarity.yellowLettersPct}%</span></div>
              <div className="row3"><span>Gray letters</span><span className="dim">{d.similarity.grayLettersPct}%</span></div>
              <div className="row3"><span>Green placement</span><span className="dim">{d.similarity.greenPlacementPct}%</span></div>
              <div className="row3"><span>Yellow placement</span><span className="dim">{d.similarity.yellowPlacementPct}%</span></div>
            </div>
          ) : (
            <div className="dim">waiting for dash_update…</div>
          )}
        </div>

        <div className="card">
          <div className="cardtitle">SHARED TAPES</div>
          {d ? (
            <div className="rows">
              <div className="row3"><span>Overlaps</span><span className="dim">{d.sharedTapeCount}</span></div>
              <div className="dim small" style={{ marginTop: 6 }}>last convergences:</div>
              {(d.sharedTapeGuesses || []).length ? (
                d.sharedTapeGuesses.map((g: string) => (
                  <div key={g} className="row3"><span>{g}</span><span className="dim">match</span></div>
                ))
              ) : (
                <div className="dim">none yet</div>
              )}
            </div>
          ) : (
            <div className="dim">waiting…</div>
          )}
        </div>
        <div className="card">
  <div className="cardtitle">SCOREBOARD</div>

  {d ? (
    <div className="rows">
      <div className="row3">
        <span>Total Score</span>
        <span className="dim">
          A: {d.totalScores?.A ?? 0} | B: {d.totalScores?.B ?? 0}
        </span>
      </div>

      <div className="row3">
        <span>Round Winner</span>
        <span className="dim">{d.winnerRole || "—"}</span>
      </div>

      <div className="row3">
        <span>Lockout</span>
        <span className="dim">{d.lockout ? "YES (0/10)" : "NO"}</span>
      </div>
    </div>
  ) : (
    <div className="dim">waiting for dash_update…</div>
  )}
</div>


        <div className="card">
          <div className="cardtitle">ROUND STATE</div>
          {d ? (
            <div className="rows">
              <div className="row3"><span>Attempts A</span><span className="dim">{d.attemptsByRole.A}</span></div>
              <div className="row3"><span>Attempts B</span><span className="dim">{d.attemptsByRole.B}</span></div>
              <div className="row3"><span>Tape uploads A</span><span className="dim">{d.tapeUploadsByRole.A}</span></div>
              <div className="row3"><span>Tape uploads B</span><span className="dim">{d.tapeUploadsByRole.B}</span></div>
              <div className="row3"><span>Winner</span><span className="dim">{d.winnerRole || "—"}</span></div>
              <div className="row3"><span>Lockout</span><span className="dim">{d.lockout ? "YES" : "NO"}</span></div>
            </div>
          ) : (
            <div className="dim">waiting…</div>
          )}
        </div>
      </div>

      <div className="dim small" style={{ marginTop: 10 }}>
        Clean-room mimic: private boards stay private; only aggregate similarity + convergence signals are shared.
      </div>
    </div>
  );
}

function KeyGrid(props: { guesses: any[]; maxTurns: number; keyLen: number }) {
  const rows = [];
  for (let r = 0; r < props.maxTurns; r++) {
    const g = props.guesses[r];
    const cells = [];
    for (let c = 0; c < props.keyLen; c++) {
      const ch = g?.guess?.[c] || "";
      const state = g?.feedback?.[c]?.state || "empty";
      cells.push(
        <div key={c} className={`tile ${state}`}>
          {ch}
        </div>
      );
    }
    rows.push(
      <div key={r} className="tilerow">
        {cells}
      </div>
    );
  }
  return <div className="tilegrid">{rows}</div>;
}
