import "dotenv/config";
import express from "express";
import cors from "cors";
import { CleanRoomsClient, StartProtectedQueryCommand, GetProtectedQueryCommand } from "@aws-sdk/client-cleanrooms";
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { parse } from "csv-parse/sync";

const app = express();
app.use(cors());
app.use(express.json());

const REGION = process.env.AWS_REGION ?? "us-west-2";
const COLLAB_ID = process.env.CLEANROOMS_COLLAB_ID!;
const RESULTS_BUCKET = process.env.RESULTS_BUCKET!;
const RESULTS_PREFIX = process.env.RESULTS_PREFIX!;

if (!COLLAB_ID || !RESULTS_BUCKET || !RESULTS_PREFIX) {
  throw new Error("Missing env vars: CLEANROOMS_COLLAB_ID, RESULTS_BUCKET, RESULTS_PREFIX");
}

const cleanrooms = new CleanRoomsClient({ region: REGION });
const s3 = new S3Client({ region: REGION });

// Your Phase 1 query (keep it simple)
const OVERLAP_SQL = `
SELECT
  a.symbol_topic,
  COUNT(*) AS overlap_count,
  AVG(a.signal_weight) AS avg_a_signal,
  AVG(b.signal_weight) AS avg_b_signal
FROM ctr_agency_a_tapes a
JOIN ctr_agency_b_tapes b
  ON a.entity_hash = b.entity_hash
GROUP BY a.symbol_topic
HAVING COUNT(*) >= 5
ORDER BY overlap_count DESC;
`.trim();

app.post("/api/queries/overlap", async (_req, res) => {
  try {
    const out = await cleanrooms.send(
      new StartProtectedQueryCommand({
        collaborationIdentifier: COLLAB_ID,
        type: "SQL",
        sqlParameters: { queryString: OVERLAP_SQL },
      })
    );

    res.json({
      protectedQueryId: out.protectedQuery?.id,
      status: out.protectedQuery?.status,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.get("/api/queries/:id", async (req, res) => {
  try {
    const id = req.params.id;

    const pq = await cleanrooms.send(
      new GetProtectedQueryCommand({
        collaborationIdentifier: COLLAB_ID,
        protectedQueryIdentifier: id,
      })
    );

    const status = pq.protectedQuery?.status;

    // Not finished yet
    if (status !== "SUCCESS") {
      return res.json({ status });
    }

    // Find most recent result object written by Clean Rooms
    const list = await s3.send(
      new ListObjectsV2Command({
        Bucket: RESULTS_BUCKET,
        Prefix: RESULTS_PREFIX,
      })
    );

    const objects = (list.Contents ?? []).filter(o => o.Key && o.Size && o.Size > 0);
    objects.sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0));

    const latest = objects[0]?.Key;
    if (!latest) return res.status(500).json({ status, error: "No result files found in S3 prefix" });

    const obj = await s3.send(new GetObjectCommand({ Bucket: RESULTS_BUCKET, Key: latest }));
    const body = await obj.Body?.transformToString();
    if (!body) return res.status(500).json({ status, error: "Empty result file body" });

    // Parse CSV -> JSON rows
    const records = parse(body, { columns: true, skip_empty_lines: true });

    res.json({
      status,
      s3Key: latest,
      rows: records,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.listen(8787, () => {
  console.log(`api listening on http://localhost:8787`);
});
