// "Clean rooms mimic":
// - each role uploads tapes privately
// - only aggregated, whitelisted queries return results

const ALLOWED = [
  {
    name: "count_tapes_by_role",
    description: "Counts how many tapes each role uploaded."
  },
  {
    name: "top_tokens_shared",
    description: "Top tokens across BOTH roles, with k-anon threshold (minCount)."
  },
  {
    name: "timeline_counts",
    description: "Counts tapes per minute bucket (aggregated)."
  }
];

export function listProtectedQueries() {
  return ALLOWED;
}

export function addTape(room, role, tape) {
  const safe = normalizeTape(tape);
  if (!room.tapes.has(role)) room.tapes.set(role, []);
  room.tapes.get(role).push(safe);
  return safe;
}

export function runProtectedQuery(room, queryName, params = {}) {
  const q = String(queryName || "");
  if (!ALLOWED.some((x) => x.name === q)) throw new Error("Query not allowed");

  if (q === "count_tapes_by_role") {
    const a = room.tapes.get("A")?.length || 0;
    const b = room.tapes.get("B")?.length || 0;
    return { A: a, B: b, total: a + b };
  }

  if (q === "top_tokens_shared") {
    const minCount = clampInt(params.minCount ?? 2, 2, 999);
    const topN = clampInt(params.topN ?? 12, 3, 40);

    const all = []
      .concat(room.tapes.get("A") || [])
      .concat(room.tapes.get("B") || []);

    const counts = new Map();
    for (const t of all) {
      const toks = tokenize(t.text);
      for (const tok of toks) counts.set(tok, (counts.get(tok) || 0) + 1);
    }

    const rows = [...counts.entries()]
      .filter(([, c]) => c >= minCount) // k-anon-ish threshold
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([token, count]) => ({ token, count }));

    return { minCount, topN, rows };
  }

  if (q === "timeline_counts") {
    const bucketMs = 60_000; // per minute
    const all = []
      .concat(room.tapes.get("A") || [])
      .concat(room.tapes.get("B") || []);

    const buckets = new Map(); // bucketStart -> count
    for (const t of all) {
      const b = Math.floor(t.ts / bucketMs) * bucketMs;
      buckets.set(b, (buckets.get(b) || 0) + 1);
    }

    const rows = [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .slice(-30)
      .map(([bucketStart, count]) => ({ bucketStart, count }));

    return { rows };
  }

  throw new Error("Unhandled query");
}

function normalizeTape(t) {
  const text = String(t?.text || "").slice(0, 2000);
  const ts = Number.isFinite(t?.ts) ? Number(t.ts) : Date.now();
  return {
    id: `${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`,
    ts,
    text
  };
}

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => w.length >= 3 && w.length <= 16);
}

function clampInt(v, lo, hi) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}
