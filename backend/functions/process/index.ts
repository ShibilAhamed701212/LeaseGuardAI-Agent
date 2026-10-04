// functions/process/index.ts — POST /process

import express, { type Request, type Response } from "express";
import { getJob, updateJobStatus } from "../utils/postgresClient";
import { pushJob, setJobStatus }   from "../utils/redisClient";
import { getSignedUrl, checkFileExists } from "../utils/minioClient";
import { triggerN8nWebhook }       from "../utils/n8nClient";
import { logger } from "../utils/logger";
import { STORED_EXTENSIONS } from "../utils/fileTypes";

const router = express.Router();

const VALID_OCR = ["google_cloud"] as const;
const VALID_AI  = ["ollama", "gemini", "custom"] as const;

type OcrEngine = (typeof VALID_OCR)[number];
type AiModel   = (typeof VALID_AI)[number];

interface AiConfig {
  apiKey?: string;
  baseUrl?: string;
  modelName?: string;
}

interface ProcessBody {
  job_id: string;
  ocr:    OcrEngine;
  ai:     AiModel;
  config?: AiConfig;
}

router.post("/", async (req: Request, res: Response): Promise<void> => {
  const { job_id, ocr, ai, config } = req.body as ProcessBody;

  // ── Input validation ───────────────────────────────────────
  if (!job_id || typeof job_id !== "string") {
    res.status(400).json({ error: "job_id is required" });
    return;
  }
  if (!ocr || !(VALID_OCR as readonly string[]).includes(ocr)) {
    res.status(400).json({ error: `Invalid ocr engine. Must be one of: ${VALID_OCR.join(", ")}` });
    return;
  }
  if (!ai || !(VALID_AI as readonly string[]).includes(ai)) {
    res.status(400).json({ error: `Invalid ai model. Must be one of: ${VALID_AI.join(", ")}` });
    return;
  }

  try {
    // 1. Validate job exists
    const job = await getJob(job_id);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    if (job.status === "processing") {
      res.status(409).json({ error: "Job is already being processed" });
      return;
    }
    if (job.status === "deleted") {
      res.status(410).json({ error: "Job has been deleted" });
      return;
    }

    // 2. Find uploaded file in MinIO (verify existence with HeadObject, then sign)
    let file_url   = "";
    for (const ext of STORED_EXTENSIONS) {
      const objectName = `uploads/${job_id}/file.${ext}`;
      try {
        const exists = await checkFileExists(objectName);
        if (exists) {
          file_url = await getSignedUrl(objectName);
          break;
        }
      } catch {
        // try next extension
      }
    }
    if (!file_url) {
      res.status(404).json({ error: "Uploaded file not found in storage" });
      return;
    }

    // 3. Update PostgreSQL status
    await updateJobStatus(job_id, "processing", ocr, ai);

    // 4. Update Redis status cache
    await setJobStatus(job_id, "processing");

    // 5. Push to Redis queue
    await pushJob(job_id, { ocr, ai, file_url, config });

    // 6. Notify n8n (optional). The job is already queued and the worker does
    // the processing, so a webhook failure must not mark the job as failed.
    await triggerN8nWebhook({ job_id, file_url, ocr, ai }).catch((err: Error) => {
      logger.warn("n8n webhook failed; job remains queued", { job_id, message: err.message });
    });

    logger.info("Processing triggered", { job_id, ocr, ai });

    // Contract: { job_id, status: "processing" }
    res.status(200).json({ job_id, status: "processing" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Process trigger failed";
    logger.error("Process handler error", { job_id, message });

    // Best-effort rollback to "failed"
    await updateJobStatus(job_id, "failed").catch(() => null);
    await setJobStatus(job_id, "failed").catch(() => null);

    res.status(500).json({ error: "Processing failed. Please try again." });
  }
});

export default router;