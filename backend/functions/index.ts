import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";
import { logger } from "./utils/logger";
import { setupGlobalErrorHandlers, runDiagnostic } from "./utils/errorHandler";
import { canViewDiagnostics, requireDiagnostics, rateLimit } from "./utils/security";

// ── Sentry Initialization ─────────────────────────────────────
Sentry.init({
  dsn: "https://8cb99fb0212ca09a93a3abbcef59e90b@o4511106055208960.ingest.de.sentry.io/4511106111504464",
  integrations: [
    nodeProfilingIntegration(),
  ],
  tracesSampleRate: 1.0,
  profilesSampleRate: 1.0,
  release: "v1.0.4-shield-final",
});
import { 
  checkDBHealth as checkDatabaseHealth, 
  migrate
} from "./utils/postgresClient";
import { checkRedisHealth } from "./utils/redisClient";
import { 
  checkStorageHealth, 
  ensureBucket 
} from "./utils/minioClient";

// ── Route Handlers ────────────────────────────────────────────

import uploadHandler from "./upload";
import statusHandler from "./status";
import processHandler from "./process";
import resultHandler from "./result";
import cleanupHandler from "./cleanup";
import debugHandler from "./debug";
import chatHandler from "./chat";

const app = express();
const port = process.env.PORT || 10000;

// ── Basic Middleware ──────────────────────────────────────────

// Behind Render's proxy, trust one hop so req.ip (used by rate limiting) is the client's address.
const trustProxy = process.env.TRUST_PROXY ?? (process.env.NODE_ENV === "production" ? "1" : "");
if (trustProxy) app.set("trust proxy", /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);

// CORS_ORIGINS: comma-separated allow-list; unset keeps the previous allow-all behaviour.
const corsOrigins = process.env.CORS_ORIGINS?.split(",").map((o) => o.trim()).filter(Boolean);
app.use(cors(corsOrigins?.length ? { origin: corsOrigins } : undefined));
app.use(express.json({ limit: "100kb" }));

// ── Super-Diagnostic Health Check ───────────────────────────

app.get("/health", async (_req, res) => {
  try {
    const [dbResult, redisResult, storageResult] = await Promise.all([
      checkDatabaseHealth(),
      checkRedisHealth(),
      checkStorageHealth()
    ]);

    const isOk = dbResult === true && redisResult === true && storageResult === true;

    // Public callers (e.g. Render's health check) get only the overall status;
    // connection errors and config hints are reserved for diagnostics access.
    if (!canViewDiagnostics(_req)) {
      res.status(200).json({ status: isOk ? "ok" : "degraded" });
      return;
    }
    const maskEnd = (val: string | undefined) => val ? `${val.substring(0, 15)}...` : "missing";

    res.status(200).json({
      status: isOk ? "ok" : "degraded",
      server: {
        uptime: process.uptime(),
        time: new Date().toISOString(),
        platform: process.platform,
        node: process.version
      },
      services: {
        database: {
          status: dbResult === true ? "connected" : "failed",
          error: dbResult === true ? null : dbResult,
          config: { host: maskEnd(process.env.PG_HOST), user: process.env.PG_USER }
        },
        redis: {
          status: redisResult === true ? "connected" : "failed",
          error: redisResult === true ? null : redisResult,
          config: { 
            source: process.env.REDIS_URL ? "REDIS_URL" : "HOST/PORT",
            host: process.env.REDIS_URL ? maskEnd(process.env.REDIS_URL) : maskEnd(process.env.REDIS_HOST)
          }
        },
        storage: {
          status: storageResult === true ? "connected" : "failed",
          error: storageResult === true ? null : storageResult,
          config: { 
            endpoint: maskEnd(process.env.MINIO_ENDPOINT),
            bucket: process.env.MINIO_BUCKET,
            ssl: process.env.MINIO_USE_SSL
          }
        }
      }
    });
  } catch (err: any) {
    res.status(500).json({ status: "error", error: err.message });
  }
});

// ── Diagnostic Endpoints ────────────────────────────────────────

app.get("/diagnostic", requireDiagnostics, async (_req, res) => {
  try {
    const result = await runDiagnostic();
    res.status(result.status === "healthy" ? 200 : result.status === "degraded" ? 200 : 503).json(result);
  } catch (err: any) {
    logger.error("Diagnostic endpoint failed", { error: err.message });
    res.status(500).json({ status: "error", error: err.message });
  }
});

app.use("/debug", requireDiagnostics);

app.get("/debug/predictions", (_req, res) => {
  const { getBugPredictions } = require("./utils/logger");
  res.json(getBugPredictions());
});

app.get("/debug/errors", (_req, res) => {
  const { getErrorTracking } = require("./utils/errorHandler");
  res.json(getErrorTracking());
});

// ── Actual API Routes ──────────────────────────────────────────

const perMinute = (name: string, envVar: string, fallback: number) =>
  rateLimit({ name, windowMs: 60_000, max: parseInt(process.env[envVar] ?? "", 10) || fallback });

app.use("/upload", perMinute("upload", "RATE_LIMIT_UPLOAD_PER_MIN", 10), uploadHandler);
app.use("/status", statusHandler);
app.use("/process", perMinute("process", "RATE_LIMIT_PROCESS_PER_MIN", 10), processHandler);
app.use("/result", resultHandler);
app.use("/cleanup", cleanupHandler);
app.use("/debug", debugHandler);
app.use("/chat", perMinute("chat", "RATE_LIMIT_CHAT_PER_MIN", 20), chatHandler);

// 3. Sentry Error Handler (V10 Setup)
Sentry.setupExpressErrorHandler(app);

// ── Initialization Logic ──────────────────────────────────────
import { startWorker } from "./worker";

async function startServer() {
  try {
    logger.info("Initializing OCR Cloud Stack...");
    
    // 1. Database
    await migrate();

    // 2. Storage
    await ensureBucket();

    // 3. Start Listening
    app.listen(Number(port), "0.0.0.0", () => {
      logger.info(`Server listening on port ${port} bound to 0.0.0.0`);
      
      // 4. Start Background Worker (after port is open)
      startWorker();
    });

  } catch (err: any) {
    logger.error("Startup partial failure", { error: err.message });
    app.listen(port, () => {
      logger.warn("Server started in diagnostic mode", { port });
    });
  }
}

// Run!
setupGlobalErrorHandlers();
startServer();