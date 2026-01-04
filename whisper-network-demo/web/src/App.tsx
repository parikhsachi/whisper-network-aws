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

  help: async (roomCode: string, sessionId: string, kind: string, payload?: any) => {
    const r = await fetch(`/api/help`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomCode, sessionId, kind, payload })
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
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
    role: (p.get("role") === "B" ? "B" : p.get("role") === "A" ? "A" : "") as "" | "A" | "B",
    name: p.get("name") || ""
  };
}

export default function App() {
  const [sessionId, setSessionId] = useState("");
  const [presence, setPresence] = useState<{ name: string; role: string }[]>([]);
  const [chat, setChat] = useState<any[]>([]);
  const [statusLine, setStatusLine] = useState("SYSTEM: idle");

  // scoring / round state
  const [scores, setScores] = useState<{ A: number; B: number }>({ A: 0, B: 0 });
  const [roundScores, setRoundScores] = useState<{ A: number; B: number } | null>(null);
  const [attemptsByRole, setAttemptsByRole] = useState<{ A: number; B: number }>({ A: 0, B: 0 });
  const [helpByRole, setHelpByRole] = useState<{ A: number; B: number }>({ A: 0, B: 0 });
  const [winnerRole, setWinnerRole] = useState<"A" | "B" | null>(null);
  const [locked, setLocked] = useState(false);

  const [puzzle, setPuzzle] = useState<any>(null);
  const [puzzleGuess, setPuzzleGuess] = useState("");
  const [puzzleHint, setPuzzleHint] = useState("");
  const [puzzleProgressState, setPuzzleProgressState] = useState<any>(null);

  const [tapeText, setTapeText] = useState("");
  const [tapeUploads, setTapeUploads] = useState<{ role: string; count: number; ts: number }[]>([]);
  const [stage, setStage] = useState<"join" | "ops">("join");

  const [roomCode, setRoomCode] = useState("");
  const [playerName, setPlayerName] = useState("");
  const [role, setRole] = useState<"A" | "B">("A");

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

    // hydrate scoring state if returned by server
    if (data.scores) setScores(data.scores);
    if (data.round?.attemptsByRole) setAttemptsByRole(data.round.attemptsByRole);
    if (data.round?.helpByRole) setHelpByRole(data.round.helpByRole);

    // Build a shareable URL that locks room+role+name
    const shareUrl =
      `${window.location.origin}/` +
      `?room=${encodeURIComponent(data.roomCode)}` +
      `&role=${encodeURIComponent(role)}` +
      `&name=${encodeURIComponent(playerName)}`;

    window.history.replaceState({}, "", shareUrl);

    setStatusLine(`SYSTEM: connected to COLLAB ${data.roomCode} as ${role}`);

    // IMPORTANT: use hostname, not localhost, so LAN/hosted links work later
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
        if (msg.scores) setScores(msg.scores);
        if (msg.round?.attemptsByRole) setAttemptsByRole(msg.round.attemptsByRole);
        if (msg.round?.helpByRole) setHelpByRole(msg.round.helpByRole);
        setLocked(false);
        setWinnerRole(null);
        setRoundScores(null);
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
        const qn = msg.queryName;
        setAnalytics((a: any) => ({ ...a, [qn]: msg.result }));
        setStatusLine(`ANALYTICS: ${qn} refreshed`);
      }

      if (msg.type === "help_signal") {
        if (msg.helpByRole) setHelpByRole(msg.helpByRole);
        setStatusLine(`HELP: ${msg.fromRole} sent ${msg.kind}`);
      }

      if (msg.type === "winner") {
        setWinnerRole(msg.winnerRole);
        setLocked(true);
        if (msg.roundScores) setRoundScores(msg.roundScores);
        if (msg.totalScores) setScores(msg.totalScores);
        if (msg.attemptsByRole) setAttemptsByRole(msg.attemptsByRole);
        if (msg.helpByRole) setHelpByRole(msg.helpByRole);
        setStatusLine(`WINNER: ${msg.winnerRole} | Round A:${msg.roundScores?.A} B:${msg.roundScores?.B}`);
      }

      if (msg.type === "lockout") {
        setWinnerRole(null);
        setLocked(true);
        setRoundScores({ A: 0, B: 0 });
        if (msg.totalScores) setScores(msg.totalScores);
        if (msg.attemptsByRole) setAttemptsByRole(msg.attemptsByRole);
        if (msg.helpByRole) setHelpByRole(msg.helpByRole);
        setStatusLine("LOCKOUT — both agents score 0/10");
      }

      if (msg.type === "puzzle_new") {
        setPuzzle(msg.puzzle);
        setPuzzleHint("");
        setPuzzleGuess("");
        setPuzzleProgressState(null);

        // reset round UI if server sent round state
        setLocked(false);
        setWinnerRole(null);
        setRoundScores(null);
        if (msg.round?.attemptsByRole) setAttemptsByRole(msg.round.attemptsByRole);
        else setAttemptsByRole({ A: 0, B: 0 });
        if (msg.round?.helpByRole) setHelpByRole(msg.round.helpByRole);
        else setHelpByRole({ A: 0, B: 0 });
      }

      if (msg.type === "puzzle_progress") {
        setPuzzleProgressState(msg.progress);
        if (msg.solved) setPuzzleHint("ACCESS GRANTED — next round loading…");
      }
    };

    ws.onclose = () => setStatusLine("SYSTEM: disconnected");
  };

  const sendChat = (text: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: "chat", text }));
  };

  const sendHelp = async (kind: string, payload: any) => {
    try {
      const out = await API.help(roomCode, sessionId, kind, payload);
      if (out?.helpByRole) setHelpByRole(out.helpByRole);
      setStatusLine(`HELP SENT: ${kind}`);
    } catch (e: any) {
      setStatusLine(`HELP ERROR: ${e?.message || "failed"}`);
    }
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
    const params = queryName === "top_tokens_shared" ? { minCount: 2, topN: 12 } : {};
    const out = await API.runProtectedQuery(roomCode, sessionId, queryName, params);
    setAnalytics((a: any) => ({ ...a, [queryName]: out.result }));
  };

  const guessKey = async () => {
    const out = await API.puzzleGuess(roomCode, sessionId, puzzleGuess);

    if (out.scores) setScores(out.scores);
    if (out.round?.attemptsByRole) setAttemptsByRole(out.round.attemptsByRole);
    if (out.round?.helpByRole) setHelpByRole(out.round.helpByRole);

    if (out.locked) {
      setLocked(true);
      setWinnerRole(out.winnerRole || null);
      setPuzzleHint(out.hint || "ROUND LOCKED");
      return;
    }

    setPuzzleProgressState(out.progress || null);
    setPuzzleHint(out.hint || "");
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
                <input
                  value={playerName}
                  onChange={(e) => setPlayerName(e.target.value)}
                  placeholder="agent name"
                />
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
                <div className="bannerTitle">MISSION</div>
                <div className="bannerText">{">> You and the other agent must share signals to crack the code."}</div>
                <div className="bannerText">{">> First to solve gets the glory, but both fail if it isn't found."}</div>
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
          <Window title="ENCRYPTOR" right="KEY BREAK">
            <div className="puzzle">
              <div className="p-title">{puzzle?.title}</div>
              <div className="p-prompt dim">{puzzle?.prompt}</div>

              <div className="cipher">
                <div className="label">KEY GRID</div>
                <KeyGrid guesses={puzzleProgressState?.guesses || []} maxTurns={puzzleProgressState?.maxTurns || 6} />
              </div>

              <div className="row2">
                <input
                  value={puzzleGuess}
                  onChange={(e) => setPuzzleGuess(e.target.value)}
                  placeholder="enter KEY guess (A-Z)"
                  disabled={locked}
                />
                <button onClick={guessKey} disabled={locked}>
                  EXECUTE
                </button>
              </div>

              <div className="hintline">{puzzleHint}</div>

              <div className="dim small">
                {locked ? "ROUND LOCKED" : "tip: send HELP signals before brute forcing — it boosts score."}
              </div>
            </div>
          </Window>

          <Window title="UPLOAD" right="PRIVATE TAPES">
            <div className="upload">
              <div className="dim small">Paste one tape per line. Stored privately under your role. Never shared raw.</div>
              <textarea value={tapeText} onChange={(e) => setTapeText(e.target.value)} placeholder={`tape line 1\n...`} />
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
            <ChatPanel chat={chat} onSend={sendChat} role={role} />

            {/* structured help controls (counted for scoring) */}
            <div style={{ padding: "10px 12px", borderTop: "1px solid rgba(57,255,106,0.12)" }}>
              <div className="dim small" style={{ marginBottom: 6 }}>
                HELP SIGNALS (count toward score)
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button onClick={() => sendHelp("hint", { text: "Try vowel-heavy guess" })}>SEND HELP</button>
                <button onClick={() => sendHelp("constraint", { text: "Double-letter likely" })}>SEND CONSTRAINT</button>
                <button onClick={() => sendHelp("strategy", { text: "Use new letters; avoid repeats" })}>SEND STRATEGY</button>
              </div>
            </div>
          </Window>

          <Window title="RECEIVER" right="ANALYTICS DASH">
            <Dashboard
              analytics={analytics}
              scores={scores}
              roundScores={roundScores}
              attemptsByRole={attemptsByRole}
              helpByRole={helpByRole}
              winnerRole={winnerRole}
              locked={locked}
            />
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

function Window(props: { title: string; right?: string; grow?: number; children: any }) {
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

function Dashboard(props: {
  analytics: any;
  scores: { A: number; B: number };
  roundScores: { A: number; B: number } | null;
  attemptsByRole: { A: number; B: number };
  helpByRole: { A: number; B: number };
  winnerRole: "A" | "B" | null;
  locked: boolean;
}) {
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
          <div className="cardtitle">SCOREBOARD</div>

          <div className="row" style={{ marginTop: 8 }}>
            <div className="k">Total</div>
            <div className="v">
              A: {props.scores.A} &nbsp;|&nbsp; B: {props.scores.B}
            </div>
          </div>

          <div className="row">
            <div className="k">Round</div>
            <div className="v">
              A: {props.roundScores?.A ?? "—"} &nbsp;|&nbsp; B: {props.roundScores?.B ?? "—"}
              {props.winnerRole ? <span className="tag"> WINNER: {props.winnerRole}</span> : null}
            </div>
          </div>

          <div className="row">
            <div className="k">Attempts</div>
            <div className="v">
              A: {props.attemptsByRole.A} &nbsp;|&nbsp; B: {props.attemptsByRole.B}
            </div>
          </div>

          <div className="row">
            <div className="k">Help</div>
            <div className="v">
              A: {props.helpByRole.A} &nbsp;|&nbsp; B: {props.helpByRole.B}
            </div>
          </div>

          {props.locked ? <div className="dim" style={{ marginTop: 8 }}>ROUND LOCKED</div> : null}
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

function KeyGrid(props: { guesses: any[]; maxTurns: number }) {
  // infer key length from feedback if available; default 4
  const inferredLen =
    props.guesses?.[0]?.feedback?.length ||
    props.guesses?.[0]?.guess?.length ||
    4;

  const rows = [];
  for (let r = 0; r < props.maxTurns; r++) {
    const g = props.guesses[r];
    const cells = [];
    for (let c = 0; c < inferredLen; c++) {
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
