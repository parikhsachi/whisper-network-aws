import "dotenv/config";
import express from "express";
import cors from "cors";

import {
  CleanRoomsClient,
  StartProtectedQueryCommand,
  GetProtectedQueryCommand,
} from "@aws-sdk/client-cleanrooms";

import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";

import parquet from "parquetjs-lite";

const REGION = process.env.AWS_REGION ?? "us-west-2";
const COLLAB_ID = mustEnv("CLEANROOMS_COLLAB_ID");
const RESULTS_BUCKET = mustEnv("RESULTS_BUCKET");
const RESULTS_PREFIX = mustEnv("RESULTS_PREFIX");
const TABLE_A = mustEnv("TABLE_A");
const TABLE_B = mustEnv("TABLE_B");

const cleanrooms = new CleanRoomsClient({ region: REGION });
const s3 = new S3Client({ region: REGION });

const app = express();
app.use(cors());
app.use(express.json());

/**
 * Phase-1 query: aggregate overlap by topic.
 * Note: entity_hash is used for join but should not appear in output.
 */
function overlapQuerySql() {
  return `
SELECT
  a.symbol_topic,
  COUNT(*) AS overlap_count,
  AVG(a.signal_weight) AS avg_a_signal,
  AVG(b.signal_weight) AS avg_b_signal
FROM ${TABLE_A} a
JOIN ${TABLE_B} b
  ON a.entity_hash = b.entity_hash
GROUP BY a.symbol_topic
HAVING COUNT(*) >= 5
ORDER BY overlap_count DESC
`;
}

/**
 * Start a protected query.
 */
app.post("/api/run", async (_req, res) => {
  try {
    const cmd = new StartProtectedQueryCommand({
      collaborationIdentifier: COLLAB_ID,
      type: "SQL",
      sqlParameters: {
        queryString: overlapQuerySql(),
      },
    });

    const out = await cleanrooms.send(cmd);
    const id = out.protectedQuery?.id;

    if (!id) {
      return res.status(500).json({ error: "No protectedQueryId returned" });
    }

    res.json({ protectedQueryId: id });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

/**
 * Get query status. If succeeded, fetch latest parquet result from S3 and return JSON.
 */
app.get("/api/run/:id", async (req, res) => {
  const id = req.params.id;

  try {
    const statusOut = await cleanrooms.send(
      new GetProtectedQueryCommand({
        collaborationIdentifier: COLLAB_ID,
        protectedQueryIdentifier: id,
      })
    );

    const status = statusOut.protectedQuery?.status ?? "UNKNOWN";

    // Return status quickly if not finished
    if (status !== "SUCCEEDED") {
      return res.json({ status });
    }

    // If succeeded, read latest result file from results prefix
    const latestKey = await getLatestResultKey(RESULTS_BUCKET, RESULTS_PREFIX);
    if (!latestKey) {
      return res.status(500).json({
        status,
        error: "Query succeeded but no result files found in results prefix",
      });
    }

    const rows = await readParquetFromS3(RESULTS_BUCKET, latestKey);

    res.json({
      status,
      resultKey: latestKey,
      rows,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.listen(8787, () => {
  console.log(`API listening on http://localhost:8787 (region=${REGION})`);
});

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function getLatestResultKey(bucket: string, prefix: string) {
  // List objects; pick the newest by LastModified
  const out = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
    })
  );

  const objs = (out.Contents ?? [])
    .filter((o) => o.Key && o.LastModified)
    // Parquet results often end with .parquet; filter to avoid markers
    .filter((o) => (o.Key ?? "").toLowerCase().endsWith(".parquet"));

  if (objs.length === 0) return null;

  objs.sort((a, b) => {
    const at = a.LastModified?.getTime() ?? 0;
    const bt = b.LastModified?.getTime() ?? 0;
    return bt - at;
  });

  return objs[0].Key!;
}

async function readParquetFromS3(bucket: string, key: string) {
  const obj = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );

  if (!obj.Body) throw new Error("S3 object had no body");

  const buf = await streamToBuffer(obj.Body as any);

  // parquetjs-lite can open from a buffer via openBuffer (available in parquetjs-lite)
  const reader = await (parquet as any).ParquetReader.openBuffer(buf);
  const cursor = reader.getCursor();
  const rows: any[] = [];

  while (true) {
    const row = await cursor.next();
    if (!row) break;
    rows.push(row);
  }

  await reader.close();
  return rows;
}

function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}
