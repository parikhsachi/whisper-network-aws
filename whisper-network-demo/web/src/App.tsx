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
  protectedQueries: async () => {
    const res = await fetch("/api/protected-queries");
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  runProtectedQuery: async (roomCode: string, sessionId: string, queryName: string, params: any) => {
    const res = await fetch("/api/protected-query/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomCode, sessionId, queryName, params })
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

export default function App() {
  const [stage, setStage] = useState<"join" | "ops">("join");

  const [roomCode, setRoomCode] = useState("");
  const [playerName, setPlayerName] = useState("agent");
  const [role, setRole] = useState<"A" | "B">("A");

  const [sessionId, setSessionId] = useState("");
  const [presence, setPresence] = useState<{ name: string; role: string }[]>([]);
  const [chat, setChat] = useState<any[]>([]);
  const [statusLine, setStatusLine] = useState("SYSTEM: idle");

  const [puzzle, setPuzzle] = useState<any>(null);
  const [puzzleGuess, setPuzzleGuess] = useState("");
  const [puzzleHint, setPuzzleHint] = useState("");
  const [puzzleProgressState, setPuzzleProgressState] = useState<any>(null);

  const [tapeText, setTapeText] = useState("");
  const [tapeUploads, setTapeUploads] = useState<{ role: string; count: number; ts: number }[]>([]);

  const [queries, setQueries] = useState<any[]>([]);
  const [analytics, setAnalytics] = useState<any>({
    count_tapes_by_role: null,
    top_tokens_shared: null,
    timeline_counts: null
  });

  const wsRef = useRef<WebSocket | null>(null);

  const connected = stage === "ops" && wsRef.current && wsRef.current.readyState === 1;

  useEffect(() => {
    (async () => {
      try {
        const q = await API.protectedQueries();
        setQueries(q.queries || []);
      } catch {
        // ignore until server running
      }
    })();
  }, []);

  const join = async () => {
    setStatusLine("SYSTEM: joining collaboration...");
    const data = await API.join(roomCode.trim(), playerName.trim() || "agent", role);

    setRoomCode(data.roomCode);
    setSessionId(data.sessionId);
    setPuzzle(data.puzzle);
    setStage("ops");
    setStatusLine(`SYSTEM: connected to COLLAB ${data.roomCode} as ${role}`);

    const ws = new WebSocket("ws://localhost:8787");
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

      if (msg.type === "presence") {
        setPresence(msg.members || []);
      }

      if (msg.type === "chat") {
        setChat((c) => c.concat([msg.message]));
      }

      if (msg.type === "system") {
        setStatusLine(`SYSTEM: ${msg.text}`);
      }

      if (msg.type === "tape_uploaded") {
        setTapeUploads((x) => x.concat([{ role: msg.role, count: msg.count, ts: Date.now() }]));
        setStatusLine(`SYSTEM: ${msg.role} uploaded ${msg.count} tapes (private)`);
      }

      if (msg.type === "analytics_updated") {
        // only the query result is broadcast; no raw tapes ever
        const qn = msg.queryName;
        setAnalytics((a: any) => ({ ...a, [qn]: msg.result }));
        setStatusLine(`ANALYTICS: ${qn} refreshed`);
      }

      if (msg.type === "puzzle_new") {
        setPuzzle(msg.puzzle);
        setPuzzleHint("");
        setPuzzleGuess("");
        setPuzzleProgressState(null);
      }

      if (msg.type === "puzzle_progress") {
        setPuzzleProgressState(msg.progress);
        if (msg.solved) setPuzzleHint("ACCESS GRANTED — new puzzle loading…");
      }
    };

    ws.onclose = () => setStatusLine("SYSTEM: disconnected");
  };

  const sendChat = (text: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: "chat", text }));
  };

  const uploadTape = async () => {
    const lines = tapeText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 50)
      .map((text) => ({ text, ts: Date.now() }));

    if (!lines.length) return;

    await API.uploadTapes(roomCode, sessionId, lines);
    setTapeText("");
  };

  const runQuery = async (queryName: string) => {
    const params =
      queryName === "top_tokens_shared"
        ? { minCount: 2, topN: 12 }
        : {};

    const out = await API.runProtectedQuery(roomCode, sessionId, queryName, params);
    setAnalytics((a: any) => ({ ...a, [queryName]: out.result }));
  };

  const guessKey = async () => {
    const out = await API.puzzleGuess(roomCode, sessionId, puzzleGuess);
    setPuzzleHint(out.hint || "");
    setPuzzleProgressState(out.progress || null);
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
                <input value={roomCode} onChange={(e) => setRoomCode(e.target.value)} placeholder="(leave blank to create)" />
              </div>

              <div className="row">
                <label>HANDLE</label>
                <input value={playerName} onChange={(e) => setPlayerName(e.target.value)} placeholder="agent name" />
              </div>

              <div className="row">
                <label>ROLE</label>
                <div className="seg">
                  <button className={role === "A" ? "on" : ""} onClick={() => setRole("A")}>A</button>
                  <button className={role === "B" ? "on" : ""} onClick={() => setRole("B")}>B</button>
                </div>
              </div>

              <div className="row">
                <button className="primary" onClick={join}>ENTER COLLAB</button>
              </div>

              <div className="hint">
                This is a local demo that mimics Clean Rooms:
                <br />
                <span className="dim">tapes are private, only whitelisted aggregate queries return results.</span>
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
        <div className="meta">
          <span className="pill">ROOM: {roomCode}</span>
          <span className="pill">ROLE: {role}</span>
          <span className="pill">{connected ? "LINK: ONLINE" : "LINK: OFFLINE"}</span>
        </div>
      </div>

      <div className="layout">
        <div className="col">
          <Window title="ENCRYPTOR" right="KEY BREAK">
            <div className="puzzle">
              <div className="p-title">{puzzle?.title}</div>
              <div className="p-prompt dim">{puzzle?.prompt}</div>

              <div className="cipher">
                <div className="label">CIPHERTEXT</div>
                <pre>{puzzle?.ciphertext}</pre>
              </div>

              <div className="row2">
                <input
                  value={puzzleGuess}
                  onChange={(e) => setPuzzleGuess(e.target.value)}
                  placeholder="enter KEY guess (A-Z)"
                />
                <button onClick={guessKey}>EXECUTE</button>
              </div>

              <div className="hintline">{puzzleHint}</div>

              <div className="dim small">
                {puzzleProgressState
                  ? `attempts=${puzzleProgressState.attempts}  keyLen=${puzzleProgressState.keyLength}  last=${puzzleProgressState.lastGuess || "-"}`
                  : "attempts=0"}
              </div>
            </div>
          </Window>

          <Window title="UPLOAD" right="PRIVATE TAPES">
            <div className="upload">
              <div className="dim small">
                Paste one tape per line. Stored privately under your role. Never shared raw.
              </div>
              <textarea
                value={tapeText}
                onChange={(e) => setTapeText(e.target.value)}
                placeholder={`tape line 1\n...`}
              />
              <div className="row2">
                <button onClick={uploadTape}>UPLOAD TAPES</button>
                <div className="dim small">Recent: {tapeUploads.slice(-1)[0] ? `${tapeUploads.slice(-1)[0].role}+${tapeUploads.slice(-1)[0].count}` : "—"}</div>
              </div>
            </div>
          </Window>

          <Window title="SCRIPTS" right="PROTECTED QUERIES">
            <div className="queries">
              {queries.map((q) => (
                <div key={q.name} className="qrow">
                  <div>
                    <div className="qname">{q.name}</div>
                    <div className="dim small">{q.description}</div>
                  </div>
                  <button onClick={() => runQuery(q.name)}>RUN</button>
                </div>
              ))}
            </div>
          </Window>
        </div>

        <div className="col">
          <Window title="TRANSFER" right="CHAT LINK">
            <ChatPanel
              chat={chat}
              onSend={sendChat}
              role={role}
            />
          </Window>

          <Window title="RECEIVER" right="ANALYTICS DASH">
            <Dashboard analytics={analytics} />
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
              <div className="line dim">tip: upload tapes as A and B, then run top_tokens_shared</div>
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

function Dashboard(props: { analytics: any }) {
  const counts = props.analytics.count_tapes_by_role;
  const top = props.analytics.top_tokens_shared;
  const tl = props.analytics.timeline_counts;

  return (
    <div className="dash">
      <div className="dashgrid">
        <div className="card">
          <div className="cardtitle">TAPES COUNT</div>
          <div className="big">
            {counts ? (
              <>
                <div>A: {counts.A}</div>
                <div>B: {counts.B}</div>
                <div className="dim">TOTAL: {counts.total}</div>
              </>
            ) : (
              <div className="dim">Run: count_tapes_by_role</div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="cardtitle">TOP TOKENS (AGG)</div>
          {top ? (
            <div className="rows">
              {top.rows.map((r: any) => (
                <div key={r.token} className="row3">
                  <span>{r.token}</span>
                  <span className="dim">{r.count}</span>
                </div>
              ))}
              <div className="dim small">threshold minCount={top.minCount}</div>
            </div>
          ) : (
            <div className="dim">Run: top_tokens_shared</div>
          )}
        </div>

        <div className="card">
          <div className="cardtitle">TIMELINE</div>
          {tl ? (
            <div className="rows">
              {tl.rows.slice(-10).map((r: any) => (
                <div key={r.bucketStart} className="row3">
                  <span className="dim">{nowTime(r.bucketStart)}</span>
                  <span>{bar(r.count)}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="dim">Run: timeline_counts</div>
          )}
        </div>
      </div>

      <div className="dim small" style={{ marginTop: 10 }}>
        Clean-room mimic: only aggregate outputs appear here; raw tapes never leave their role.
      </div>
    </div>
  );
}

function bar(n: number) {
  const k = Math.max(1, Math.min(24, n));
  return "█".repeat(k);
}
