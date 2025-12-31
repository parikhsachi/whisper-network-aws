import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import parquet from "@dsnp/parquetjs-lite";
type TapeRow = {
  time_bucket: string;
  symbol_topic: string;
  entity_hash: string;
  location_zone: string;
  signal_weight: number;
  signal_class: string;
  dt: string;
};

const TOPICS = [
  "courier_network",
  "ransom_trade",
  "identity_forgery",
  "port_activity",
  "grey_market",
  "signal_jamming",
  "border_transit",
];

const ZONES = ["NW-URBAN", "NE-URBAN", "SOUTH-PORT", "WEST-RURAL", "INTL-HUB"];
const CLASSES = ["anomaly_detector", "human_tag", "keyword_class", "pattern_match"];

function hashEntity(seed: string) {
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

function isoHour(d: Date) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}`;
}

function isoDate(d: Date) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function rand<T>(arr: T[]) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

/**
 * Generate synthetic cipher tapes for one "agency".
 * overlapPool controls cross-agency resonance: pass the same pool to both agencies.
 */
function generateRows(agency: "A" | "B", start: Date, hours: number, rowsPerHour: number, overlapPool: string[]): TapeRow[] {
  const rows: TapeRow[] = [];
  for (let h = 0; h < hours; h++) {
    const t = new Date(start.getTime() + h * 3600_000);
    const time_bucket = isoHour(t);
    const dt = isoDate(t);

    for (let i = 0; i < rowsPerHour; i++) {
      const topic = rand(TOPICS);
      const zone = rand(ZONES);
      const signal_class = rand(CLASSES);

      // 20% of the time choose an "overlap" entity seen by multiple agencies
      const useOverlap = Math.random() < 0.2;
      const baseEntity = useOverlap
        ? rand(overlapPool)
        : `${agency}-${topic}-${zone}-${h}-${i}-${Math.random()}`;

      const entity_hash = hashEntity(baseEntity);

      // weights: agency B slightly noisier
      const weightBase = agency === "A" ? 0.55 : 0.48;
      const jitter = (Math.random() - 0.5) * 0.35;
      const signal_weight = clamp01(weightBase + jitter);

      rows.push({
        time_bucket,
        symbol_topic: topic,
        entity_hash,
        location_zone: zone,
        signal_weight,
        signal_class,
        dt,
      });
    }
  }
  return rows;
}

async function writeParquet(outPath: string, rows: TapeRow[]) {
  const schema = new parquet.ParquetSchema({
    time_bucket: { type: "UTF8" },
    symbol_topic: { type: "UTF8" },
    entity_hash: { type: "UTF8" },
    location_zone: { type: "UTF8" },
    signal_weight: { type: "DOUBLE" },
    signal_class: { type: "UTF8" },
    dt: { type: "UTF8" },
  });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const writer = await parquet.ParquetWriter.openFile(schema, outPath);
  for (const r of rows) await writer.appendRow(r);
  await writer.close();
}

async function main() {
  const start = new Date(Date.UTC(2025, 11, 31, 0, 0, 0)); // Dec 31, 2025 UTC
  const hours = 6;
  const rowsPerHour = 200;

  // Shared overlap pool to create “resonance”
  const overlapPool = Array.from({ length: 80 }, (_, i) => `OVERLAP-${i}`);

  const aRows = generateRows("A", start, hours, rowsPerHour, overlapPool);
  const bRows = generateRows("B", start, hours, rowsPerHour, overlapPool);

  const outDir = path.resolve(process.cwd(), "..", "out");
  const aPath = path.join(outDir, "agency_a", "tapes", `dt=2025-12-31`, "tapes.parquet");
  const bPath = path.join(outDir, "agency_b", "tapes", `dt=2025-12-31`, "tapes.parquet");

  await writeParquet(aPath, aRows);
  await writeParquet(bPath, bRows);

  console.log("Wrote:");
  console.log(" ", aPath);
  console.log(" ", bPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
