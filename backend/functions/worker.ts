// worker.ts — Standalone AI/OCR Queue Processor
import { GoogleGenerativeAI } from "@google/generative-ai";
import pdfParse from "pdf-parse";
import { getClient, storeResult, setJobStatus } from "./utils/redisClient";
import { updateJobStatus as updatePgStatus } from "./utils/postgresClient";
import * as Sentry from "@sentry/node";
import { logger } from "./utils/logger";
import { mimeFromUrl } from "./utils/fileTypes";

const POLL_INTERVAL = 3000;
const GEMINI_TIMEOUT_MS = 60_000;
const redis = getClient();

interface AiConfig {
  apiKey?: string;
  baseUrl?: string;
  modelName?: string;
}

interface WorkerJob {
  job_id:   string;
  file_url: string;
  ocr:      string;
  ai:       string;
  config?:  AiConfig;
}

const DEFAULT_GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const DEFAULT_OLLAMA_URL = process.env.OLLAMA_HOST ? `http://${process.env.OLLAMA_HOST}:11434` : "http://localhost:11434";

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function downloadFileBuffer(url: string, retries = 3): Promise<Buffer> {
  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout
      
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (err: any) {
      if (i === retries - 1) {
        logger.error("File download failed permanently", { url, error: err.message });
        throw new Error(`Download failed: ${err.message}`);
      }
      logger.warn(`Download retry ${i + 1}/${retries}`, { error: err.message });
      await sleep(1000 * (i + 1));
    }
  }
  throw new Error("Download failed");
}

/** 
 * OCR Extract: Uses Gemini 1.5 Flash to extract raw text if the native PDF layer is missing 
 * or if the file is an image.
 */
async function extractTextWithGoogleCloud(buffer: Buffer, mimeType: string, config?: AiConfig): Promise<string> {
  const apiKey = config?.apiKey || DEFAULT_GEMINI_KEY;
  if (!apiKey) throw new Error("Google Cloud OCR requires a Gemini API Key");

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const inlineData = {
    data: buffer.toString("base64"),
    mimeType: mimeType === "application/pdf" ? "application/pdf" : mimeType.startsWith("image/") ? mimeType : "image/jpeg"
  };

  try {
    const result = await model.generateContent([
      { text: "Extract all text from this document accurately. Do not add comments." },
      { inlineData }
    ]);
    return result.response.text() || "No text found via Google Cloud OCR.";
  } catch (err: any) {
    logger.error("Google Cloud OCR fetch failed", { error: err.message });
    throw new Error(`Google OCR failed: ${err.message}`);
  }
}

async function extractTextWithPdfParse(buffer: Buffer, mimeType: string, config?: AiConfig): Promise<string> {
  try {
    if (mimeType === "application/pdf") {
      // @ts-ignore
      const data = await pdfParse(buffer);
      let text = data.text?.trim();
      if (text && text.length > 100) return text;
    }
    
    // Fallback to Gemini OCR for images or scanned PDFs
    logger.info("Falling back to Google Cloud OCR for deep scan");
    return await extractTextWithGoogleCloud(buffer, mimeType, config);
  } catch (err: any) {
    logger.warn("Document parsing failure, using Google Cloud fallback", { err: err.message });
    return await extractTextWithGoogleCloud(buffer, mimeType, config);
  }
}

async function processOllama(text: string, config?: AiConfig): Promise<any> {
  const baseUrl = config?.baseUrl || DEFAULT_OLLAMA_URL;
  const model = config?.modelName || "llama3.2"; // smallest model default
  
  const prompt = `Extract structured SLA data from this lease contract. 
Return ONLY valid JSON with keys: {apr, monthly_payment, term, residual_value, mileage_limit, penalties}. 
No markdown. No explanation. Data:\n\n${text}`;

  try {
    const response = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        prompt,
      }),
    });

    if (!response.ok) throw new Error(`Ollama API error: ${response.status}`);
    const data: any = await response.json();
    const rawResponse = data.response || "";
    return parseJsonResponse(rawResponse);
  } catch (err: any) {
    logger.error("Ollama fetch failed", { baseUrl, error: err.message });
    throw new Error(`Ollama failed: ${err.message}`);
  }
}

async function processGemini(buffer: Buffer, mimeType: string, config?: AiConfig): Promise<any> {
  const apiKey = config?.apiKey || DEFAULT_GEMINI_KEY;
  if (!apiKey) throw new Error("Gemini API key is required but missing");

  // Safety Shield: Map invalid versions to standard gemini-2.5-flash
  let modelName = config?.modelName || "gemini-2.5-flash";
  if (modelName === "gemini") modelName = "gemini-2.5-flash";

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel(
    {
      model: modelName,
      generationConfig: {
        responseMimeType: "application/json"
      }
    },
    { timeout: GEMINI_TIMEOUT_MS }
  );

  const prompt = `You are a legal-financial contract analyzer specialized in vehicle lease agreements.

Your job is to extract, normalize, and interpret ALL financial and risk-related details from the document.

IMPORTANT RULES:
1. Do NOT assume missing values if they are indirectly stated.
2. Detect hidden or ambiguous values (e.g., "45k/month with driver" = monthly payment 45000).
3. Convert all financial strings into pure numbers. 
4. Detect currency: ₹=INR, $=USD. Default to INR if ₹ or "Lakh" is found.
5. If payment is written like "45k/month" → interpret as 45000.
6. Term months: calculate duration strictly from dates if needed.
7. NEVER output $0 for total or payment unless explicitly stated.

STRICT JSON FORMAT:
{
  "currency": "INR",
  "monthly_payment": number or null,
  "term_months": number or null,
  "total_cost": number or null,
  "deposit": number or null,
  "mileage": "string",
  "residual_value": "string/rule",
  "gap_liability": "string/who pays",
  "maintenance": "string (Lessor/Lessee)",
  "insurance": "string (Lessor/Lessee)",
  "taxes": "string (Lessor/Lessee)",
  "purchase_option": "boolean",
  "penalties": ["list of strings"],
  "financial_risk": "Low/Medium/High",
  "legal_risk": "Low/Medium/High",
  "fairness_score": number (0-100),
  "confidence": number (0-100),
  "issues_detected": ["list of strings"],
  "fairness_explanation": "short reasoning"
}`;

  const inlineData = {
    data: buffer.toString("base64"),
    mimeType: mimeType === "application/pdf" ? "application/pdf" : mimeType.startsWith("image/") ? mimeType : "image/jpeg"
  };

  try {
    const response = await model.generateContent([
      { text: prompt },
      { inlineData }
    ]);

    const text = response.response.text();
    if (!text) throw new Error("Empty response from Gemini");
    return parseJsonResponse(text);
  } catch (err: any) {
    if (err.name === "AbortError" || /abort/i.test(err.message ?? "")) {
      throw new Error("Gemini AI request timed out (60s limit reached)");
    }
    logger.error("Gemini AI fetch failed", { error: err.message });
    throw new Error(`Gemini AI failed: ${err.message}`);
  }
}

async function processCustomOpenAi(text: string, config?: AiConfig): Promise<any> {
  if (!config?.baseUrl || !config?.apiKey) {
    throw new Error("Custom Custom Node requires Base URL and API Key");
  }
  const model = config.modelName || "gpt-3.5-turbo";

  const prompt = `Extract structured SLA data from this lease contract. Return ONLY raw JSON: {"apr": null, "monthly_payment": null, "term": null, "residual_value": null, "mileage_limit": null, "penalties": null}. No markdown.\n\n${text}`;

  const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [{ role: "user", content: prompt }]
    }),
  });

  if (!response.ok) {
    const txt = await response.text();
    throw new Error(`OpenAI API Error: ${response.status} - ${txt}`);
  }
  const data: any = await response.json();
  return parseJsonResponse(data.choices?.[0]?.message?.content || "");
}

function parseJsonResponse(text: string): any {
  let cleaned = text.replace(/\`\`\`json/gi, "").replace(/\`\`\`/g, "").replace(/\s+/g, " ").trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    // Log only the length: the raw output contains contract data, which must not reach server logs.
    logger.warn("Failed to parse AI output, returning fallback JSON", { outputLength: cleaned.length });
    return {
      apr: null, monthly_payment: null, term: null, 
      residual_value: null, mileage_limit: null, penalties: null
    };
  }
}

// ── Background Worker Loop ───────────────────────────────────────

let isWorking = false;

async function processJob(job: WorkerJob) {
  logger.info(`Worker picked up job: ${job.job_id}`);

  try {
    await setJobStatus(job.job_id, "reading_document").catch(() => null);
    const fileBuffer = await downloadFileBuffer(job.file_url);
    const mimeType = mimeFromUrl(job.file_url);

    let sla = null;

    if (job.ai === "gemini") {
      await setJobStatus(job.job_id, "analyzing_contract").catch(() => null);
      // Gemini 1.5 natively supports multimodal OCR + extraction!
      sla = await processGemini(fileBuffer, mimeType, job.config);
    } else {
      // Require Text extraction for Ollama or Custom OpenAI
      let text = await extractTextWithPdfParse(fileBuffer, mimeType, job.config);

      await setJobStatus(job.job_id, "analyzing_contract").catch(() => null);
      if (job.ai === "ollama") {
        sla = await processOllama(text, job.config);
      } else if (job.ai === "custom") {
        sla = await processCustomOpenAi(text, job.config);
      } else {
        throw new Error(`Unsupported AI Model: ${job.ai}`);
      }
    }

    // 1. Core Score from AI
    let fairness_score = sla.fairness_score || 70;
    
    // 2. Penalty Adjustments (Strict Reasoning)
    if (sla.financial_risk === "High") fairness_score -= 15;
    if (sla.legal_risk === "High") fairness_score -= 10;
    if (sla.maintenance === "Lessee") fairness_score -= 5;
    if (sla.insurance === "Lessee") fairness_score -= 5;
    
    fairness_score = Math.max(10, Math.min(100, fairness_score));

    // Data Presence Confidence
    const confidence = sla.confidence || 70;

    const resultPayload = {
      sla: {
        ...sla,
        apr: null, // deprecated in new prompt but preserved for API
        term: sla.term_months,
        residual_value: typeof sla.residual_value === "string" ? null : sla.residual_value, // compat
        mileage_limit: typeof sla.mileage === "string" ? parseInt(sla.mileage) || null : sla.mileage, // compat
        penalties: Array.isArray(sla.penalties) ? sla.penalties.join(", ") : (sla.fairness_explanation || "No penalties listed.")
      },
      vin: null,
      price_estimate: { 
        market_value: sla.total_cost || (sla.monthly_payment ? sla.monthly_payment * (sla.term_months || 48) : null), 
        confidence,
        currency: sla.currency || "INR"
      },
      fairness_score,
      negotiation_tips: [
        ...(sla.issues_detected || []),
        sla.fairness_explanation || "Verify the residual clauses carefully."
      ].filter(Boolean)
    };

    await storeResult(job.job_id, resultPayload);
    await setJobStatus(job.job_id, "completed").catch(() => null);
    await updatePgStatus(job.job_id, "completed").catch(() => null);
    
    logger.info(`Worker completed job: ${job.job_id}`);
  } catch (err: any) {
    logger.error(`Worker failed job: ${job.job_id}`, { 
      message: err.message,
      stack: err.stack?.substring(0, 200)
    });
    // Store last error for /debug
    await redis.set("ocr:worker:last_error", `${new Date().toISOString()} - ${err.message}`, "EX", 3600).catch(() => null);
    
    // Capture to Sentry
    Sentry.captureException(err);

    await setJobStatus(job.job_id, "failed").catch(() => null);
    await updatePgStatus(job.job_id, "failed").catch(() => null);
  }
}

/** 
 * Self-healing: Find jobs in PG that are stuck in 'processing' but not in Redis queue.
 * Cleans up orphaned states after system restarts or hard crashes on Render.
 */
async function healOrphanedJobs() {
  try {
    const pool = require("./utils/postgresClient").getPool();
    // Mark as failed if processing and created > 5 min ago (to avoid race with new jobs)
    const res = await pool.query(`
      UPDATE jobs 
         SET status = 'failed', updated_at = NOW()
       WHERE status = 'processing' 
         AND updated_at < NOW() - INTERVAL '5 minutes'
   RETURNING job_id
    `);
    if (res.rowCount > 0) {
      // /status reads Redis first, so the cached intermediate status must be overwritten too.
      for (const row of res.rows as { job_id: string }[]) {
        await setJobStatus(row.job_id, "failed").catch(() => null);
      }
      logger.info(`Self-healing: recovered ${res.rowCount} orphaned processing jobs.`);
    }
  } catch (err: any) {
    logger.warn("Self-healing check failed", { error: err.message });
  }
}

export function startWorker() {
  logger.info("Starting Background AI Worker engine...");
  
  // 1. Immediate healing on startup
  healOrphanedJobs().catch(() => null);

  // 2. Main loop
  setInterval(async () => {
    if (isWorking) return;
    try {
      isWorking = true;
      // Heartbeat: expire in 10s (poll is 3s)
      await redis.set("ocr:worker:heartbeat", "active", "EX", 10).catch(() => null);
      
      // BLPOP or LPOP for FIFO queue (push is RPUSH, pop should be LPOP)
      const jobString = await redis.lpop("ocr:queue");
      if (jobString) {
        const job = JSON.parse(jobString) as WorkerJob;
        await processJob(job);
      }
    } catch (err: any) {
      logger.error("Queue Worker Poll Error", { error: err.message });
    } finally {
      isWorking = false;
    }
  }, POLL_INTERVAL);

  // 3. Periodic healing (every 5 minutes)
  setInterval(() => {
    if (!isWorking) healOrphanedJobs().catch(() => null);
  }, 300000); // 5 min
}

