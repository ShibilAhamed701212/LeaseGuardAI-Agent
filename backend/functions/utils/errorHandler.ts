// utils/errorHandler.ts — Anti-crash system with global error handling and automatic recovery

import { logger, recordCrash, getBugPredictions, type BugPrediction } from "./logger";
import { getPool, closePool } from "./postgresClient";
import { getClient as getRedis, closeRedis } from "./redisClient";

interface RecoveryAction {
  name: string;
  execute: () => Promise<void>;
  description: string;
}

interface ErrorTracker {
  error: string;
  count: number;
  lastOccurrence: Date;
  consecutiveFailures: number;
  isRecovering: boolean;
}

const errorTrackers: Map<string, ErrorTracker> = new Map();
const MAX_CONSECUTIVE_FAILURES = 3;
const ERROR_WINDOW_MS = 60000;
const RECOVERY_COOLDOWN_MS = 30000;

let isShuttingDown = false;
let lastRecoveryTime = 0;

const recoveryActions: RecoveryAction[] = [
  {
    name: "reconnect_database",
    description: "Close and recreate PostgreSQL connection pool",
    execute: async () => {
      await closePool();
      const { getPool:重新获取池 } = await import("./postgresClient");
      重新获取池();
      logger.info("Database reconnected via recovery");
    }
  },
  {
    name: "reconnect_redis",
    description: "Close and recreate Redis connection",
    execute: async () => {
      await closeRedis();
      const { getClient:重新获取Redis } = await import("./redisClient");
      重新获取Redis();
      logger.info("Redis reconnected via recovery");
    }
  },
  {
    name: "clear_queues",
    description: "Clear stuck processing queues",
    execute: async () => {
      const redis = getRedis();
      await redis.del("ocr:queue:stuck");
      await redis.del("ocr:processing");
      logger.info("Cleared stuck queues");
    }
  },
  {
    name: "reset_memory",
    description: "Force garbage collection if available",
    execute: async () => {
      if (global.gc) {
        global.gc();
        logger.info("Garbage collection triggered");
      }
    }
  }
];

function trackError(errorType: string): { shouldRecover: boolean; tracker: ErrorTracker } {
  const now = new Date();
  let tracker = errorTrackers.get(errorType);
  
  if (!tracker) {
    tracker = {
      error: errorType,
      count: 0,
      lastOccurrence: now,
      consecutiveFailures: 0,
      isRecovering: false
    };
    errorTrackers.set(errorType, tracker);
  }
  
  const timeSinceLastError = now.getTime() - tracker.lastOccurrence.getTime();
  
  if (timeSinceLastError > ERROR_WINDOW_MS) {
    tracker.consecutiveFailures = 0;
  }
  
  tracker.count++;
  tracker.lastOccurrence = now;
  tracker.consecutiveFailures++;
  
  const shouldRecover = tracker.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
  
  return { shouldRecover, tracker };
}

async function executeRecovery(tracker: ErrorTracker): Promise<string> {
  if (tracker.isRecovering) {
    return "Already recovering";
  }
  
  const now = Date.now();
  if (now - lastRecoveryTime < RECOVERY_COOLDOWN_MS) {
    return "Recovery cooldown active";
  }
  
  tracker.isRecovering = true;
  lastRecoveryTime = now;
  
  logger.warn("Starting automatic recovery", { error: tracker.error, count: tracker.consecutiveFailures });
  
  let lastError = "";
  
  for (const action of recoveryActions) {
    try {
      await action.execute();
      logger.info(`Recovery action completed: ${action.name}`);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      logger.error(`Recovery action failed: ${action.name}`, { error: lastError });
    }
  }
  
  tracker.isRecovering = false;
  tracker.consecutiveFailures = 0;
  
  return lastError || "Recovery completed";
}

export function setupGlobalErrorHandlers(): void {
  process.on("uncaughtException", (error: Error) => {
    logger.critical("Uncaught Exception", { 
      error: error.message, 
      stack: error.stack 
    });
    
    recordCrash(error, { type: "uncaughtException" }, "process restart required");
    
    if (!isShuttingDown) {
      isShuttingDown = true;
      logger.info("Shutting down gracefully after uncaught exception...");
      setTimeout(() => process.exit(1), 5000);
    }
  });
  
  process.on("unhandledRejection", (reason: unknown, promise: Promise<unknown>) => {
    const errorMsg = reason instanceof Error ? reason.message : String(reason);
    logger.error("Unhandled Promise Rejection", { 
      error: errorMsg, 
      reason: String(reason) 
    });
    
    if (reason instanceof Error) {
      recordCrash(reason, { type: "unhandledRejection" });
    }
    
    const { shouldRecover, tracker } = trackError(errorMsg);
    
    if (shouldRecover) {
      logger.warn("Triggering automatic recovery due to repeated failures", { 
        error: errorMsg,
        failures: tracker.consecutiveFailures 
      });
      executeRecovery(tracker);
    }
  });
  
  process.on("SIGTERM", async () => {
    logger.info("SIGTERM received, graceful shutdown");
    isShuttingDown = true;
    await gracefulShutdown();
  });
  
  process.on("SIGINT", async () => {
    logger.info("SIGINT received, graceful shutdown");
    isShuttingDown = true;
    await gracefulShutdown();
  });
  
  process.on("beforeExit", (code) => {
    logger.info("Process exiting", { code });
  });
  
  logger.info("Global error handlers initialized");
}

async function gracefulShutdown(): Promise<void> {
  try {
    await closeRedis();
    await closePool();
    logger.info("Graceful shutdown complete");
  } catch (err) {
    logger.error("Error during shutdown", { error: String(err) });
  } finally {
    process.exit(0);
  }
}

export function getErrorTracking(): Array<{
  error: string;
  count: number;
  lastOccurrence: string;
  isRecovering: boolean;
}> {
  return Array.from(errorTrackers.values()).map(t => ({
    error: t.error,
    count: t.count,
    lastOccurrence: t.lastOccurrence.toISOString(),
    isRecovering: t.isRecovering
  }));
}

export function clearErrorTracking(): void {
  errorTrackers.clear();
}

export function getRecoveryActions(): RecoveryAction[] {
  return recoveryActions;
}

export async function runDiagnostic(): Promise<{
  status: "healthy" | "degraded" | "unhealthy";
  checks: Array<{
    name: string;
    status: "ok" | "error" | "warning";
    message: string;
    timestamp: string;
  }>;
  predictions: BugPrediction[];
  errorTracking: ReturnType<typeof getErrorTracking>;
}> {
  const checks: Array<{
    name: string;
    status: "ok" | "error" | "warning";
    message: string;
    timestamp: string;
  }> = [];
  
  try {
    const pool = getPool();
    await pool.query("SELECT 1");
    checks.push({ name: "database", status: "ok", message: "PostgreSQL connected", timestamp: new Date().toISOString() });
  } catch (err) {
    checks.push({ name: "database", status: "error", message: String(err), timestamp: new Date().toISOString() });
  }
  
  try {
    const redis = getRedis();
    await redis.ping();
    checks.push({ name: "redis", status: "ok", message: "Redis connected", timestamp: new Date().toISOString() });
  } catch (err) {
    checks.push({ name: "redis", status: "error", message: String(err), timestamp: new Date().toISOString() });
  }
  
  const memUsage = process.memoryUsage();
  const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
  
  checks.push({ 
    name: "memory", 
    status: heapUsedMB > heapTotalMB * 0.9 ? "warning" : "ok", 
    message: `Heap: ${heapUsedMB}MB / ${heapTotalMB}MB`,
    timestamp: new Date().toISOString() 
  });
  
  checks.push({
    name: "uptime",
    status: "ok",
    message: `${Math.round(process.uptime())}s`,
    timestamp: new Date().toISOString()
  });
  
  const errorCount = Array.from(errorTrackers.values()).reduce((sum, t) => sum + t.count, 0);
  if (errorCount > 10) {
    checks.push({ name: "errors", status: "warning", message: `${errorCount} errors tracked`, timestamp: new Date().toISOString() });
  } else if (errorCount > 0) {
    checks.push({ name: "errors", status: "ok", message: `${errorCount} errors tracked`, timestamp: new Date().toISOString() });
  } else {
    checks.push({ name: "errors", status: "ok", message: "No errors", timestamp: new Date().toISOString() });
  }
  
  const hasError = checks.some(c => c.status === "error");
  const hasWarning = checks.some(c => c.status === "warning");
  
  return {
    status: hasError ? "unhealthy" : hasWarning ? "degraded" : "healthy",
    checks,
    predictions: getBugPredictions(),
    errorTracking: getErrorTracking()
  };
}
