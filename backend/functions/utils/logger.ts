// utils/logger.ts — Enhanced structured logger with debug file, crash recovery & bug detection

import * as fs from "fs";
import * as path from "path";

type LogLevel = "info" | "warn" | "error" | "debug" | "critical";

interface LogEntry {
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
  timestamp: string;
  trace?: string;
}

interface CrashReport {
  id: string;
  timestamp: string;
  error: string;
  stack?: string;
  context: Record<string, unknown>;
  recoveryAction?: string;
}

export interface BugPrediction {
  id: string;
  timestamp: string;
  issue: string;
  severity: "low" | "medium" | "high" | "critical";
  recommendation: string;
  occurrenceCount: number;
}

const LOG_DIR = process.env.LOG_DIR || path.join(process.cwd(), "logs");
const DEBUG_FILE = process.env.DEBUG_FILE === "true";
const LOG_MAX_SIZE_MB = parseInt(process.env.LOG_MAX_SIZE_MB || "10", 10);
const LOG_MAX_FILES = parseInt(process.env.LOG_MAX_FILES || "5", 10);

let logStream: fs.WriteStream | null = null;
let crashReports: CrashReport[] = [];
let bugPredictions: Map<string, BugPrediction> = new Map();
let errorCounts: Map<string, number> = new Map();

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function getLogFilePath(date: Date): string {
  const dateStr = date.toISOString().split("T")[0];
  return path.join(LOG_DIR, `ocr-agent-${dateStr}.log`);
}

function rotateLogsIfNeeded(): void {
  try {
    const files = fs.readdirSync(LOG_DIR)
      .filter(f => f.startsWith("ocr-agent-") && f.endsWith(".log"))
      .sort()
      .reverse();
    
    let totalSize = 0;
    for (const file of files) {
      const stat = fs.statSync(path.join(LOG_DIR, file));
      totalSize += stat.size;
    }
    
    const totalSizeMB = totalSize / (1024 * 1024);
    if (totalSizeMB > LOG_MAX_SIZE_MB * LOG_MAX_FILES) {
      for (let i = files.length - 1; i >= LOG_MAX_FILES; i--) {
        fs.unlinkSync(path.join(LOG_DIR, files[i]));
      }
    }
  } catch (err) {
    console.error("Log rotation failed:", err);
  }
}

function getWriteStream(): fs.WriteStream {
  if (!logStream) {
    ensureLogDir();
    rotateLogsIfNeeded();
    logStream = fs.createWriteStream(getLogFilePath(new Date()), { flags: "a" });
    
    logStream.on("error", (err) => {
      console.error("Log stream error:", err);
      logStream = null;
    });
  }
  return logStream;
}

function logToFile(entry: LogEntry): void {
  if (!DEBUG_FILE) return;
  try {
    const stream = getWriteStream();
    stream.write(JSON.stringify(entry) + "\n");
  } catch (err) {
    console.error("Failed to write to log file:", err);
  }
}

function detectBugPattern(error: string, context: Record<string, unknown>): BugPrediction | null {
  const patterns: { pattern: RegExp; issue: string; severity: BugPrediction["severity"]; recommendation: string }[] = [
    { pattern: /ECONNREFUSED/i, issue: "Redis/DB connection refused", severity: "critical", recommendation: "Check if Redis/PostgreSQL services are running" },
    { pattern: /ETIMEDOUT|timeout/i, issue: "Connection timeout", severity: "medium", recommendation: "Increase timeout values or check network latency" },
    { pattern: /out of memory|MEMORY/i, issue: "Memory exhaustion", severity: "critical", recommendation: "Scale up server or optimize memory usage" },
    { pattern: /SQLITE.*locked|EBUSY/i, issue: "Database lock conflict", severity: "high", recommendation: "Use WAL mode or implement retry logic" },
    { pattern: /invalid json|JSON/i, issue: "JSON parsing error", severity: "medium", recommendation: "Validate JSON before parsing, add try-catch" },
    { pattern: /undefined.*property|is not a function/i, issue: "TypeError: undefined", severity: "high", recommendation: "Add null checks or optional chaining" },
    { pattern: /401|unauthorized/i, issue: "Authentication failure", severity: "high", recommendation: "Verify API keys and tokens" },
    { pattern: /429|rate limit/i, issue: "Rate limit exceeded", severity: "medium", recommendation: "Implement exponential backoff" },
    { pattern: /disk full|ENOSPC/i, issue: "Disk space low", severity: "critical", recommendation: "Free up disk space or scale storage" },
    { pattern: /max.*connections|pool.*exhausted/i, issue: "Connection pool exhausted", severity: "high", recommendation: "Increase pool size or implement connection pooling" },
  ];

  for (const { pattern, issue, severity, recommendation } of patterns) {
    if (pattern.test(error)) {
      const key = issue;
      const existing = bugPredictions.get(key);
      if (existing) {
        existing.occurrenceCount++;
        return existing;
      }
      return {
        id: `bug-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        timestamp: new Date().toISOString(),
        issue,
        severity,
        recommendation,
        occurrenceCount: 1
      };
    }
  }
  return null;
}

function trackError(errorType: string): void {
  const count = errorCounts.get(errorType) || 0;
  errorCounts.set(errorType, count + 1);
  
  if (count > 5) {
    const prediction: BugPrediction = {
      id: `recurring-${Date.now()}`,
      timestamp: new Date().toISOString(),
      issue: `Recurring error: ${errorType}`,
      severity: "high",
      recommendation: `Error "${errorType}" occurred ${count} times - investigate root cause`,
      occurrenceCount: count
    };
    bugPredictions.set(errorType, prediction);
  }
}

function log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  const stack = level === "error" || level === "critical" ? new Error().stack : undefined;
  
  const entry: LogEntry = {
    level,
    message,
    context: sanitizeContext(context),
    timestamp: new Date().toISOString(),
    trace: stack
  };

  logToFile(entry);

  if (level === "error" || level === "critical") {
    trackError(message);
    const bug = detectBugPattern(message, context || {});
    if (bug) {
      bugPredictions.set(bug.issue, bug);
    }
  }

  if (level === "error") {
    console.error(JSON.stringify(entry));
  } else if (level === "warn") {
    console.warn(JSON.stringify(entry));
  } else if (level === "critical") {
    console.error(`CRITICAL: ${JSON.stringify(entry)}`);
  } else {
    console.log(JSON.stringify(entry));
  }
}

function sanitizeContext(context?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!context) return undefined;
  
  const sensitive = ["password", "apiKey", "token", "secret", "creditCard", "ssn"];
  const sanitized: Record<string, unknown> = {};
  
  for (const [key, value] of Object.entries(context)) {
    const lowerKey = key.toLowerCase();
    if (sensitive.some(s => lowerKey.includes(s))) {
      sanitized[key] = "[REDACTED]";
    } else if (typeof value === "string" && value.length > 1000) {
      sanitized[key] = value.substring(0, 1000) + "...[truncated]";
    } else {
      sanitized[key] = value;
    }
  }
  
  return sanitized;
}

export const logger = {
  info:  (msg: string, ctx?: Record<string, unknown>) => log("info",  msg, ctx),
  warn:  (msg: string, ctx?: Record<string, unknown>) => log("warn",  msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => log("error", msg, ctx),
  debug: (msg: string, ctx?: Record<string, unknown>) => log("debug", msg, ctx),
  critical: (msg: string, ctx?: Record<string, unknown>) => log("critical", msg, ctx),
};

export function getDebugLogs(hours: number = 24): LogEntry[] {
  const logs: LogEntry[] = [];
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
  
  try {
    ensureLogDir();
    const files = fs.readdirSync(LOG_DIR)
      .filter(f => f.startsWith("ocr-agent-") && f.endsWith(".log"))
      .sort()
      .reverse();
    
    for (const file of files) {
      const content = fs.readFileSync(path.join(LOG_DIR, file), "utf-8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as LogEntry;
          if (new Date(entry.timestamp) >= cutoff) {
            logs.push(entry);
          }
        } catch {}
      }
    }
  } catch (err) {
    console.error("Failed to read debug logs:", err);
  }
  
  return logs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

export function getBugPredictions(): BugPrediction[] {
  return Array.from(bugPredictions.values()).sort((a, b) => {
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    return severityOrder[a.severity] - severityOrder[b.severity];
  });
}

export function getCrashReports(): CrashReport[] {
  return crashReports;
}

export function recordCrash(error: Error, context: Record<string, unknown>, recoveryAction?: string): void {
  const report: CrashReport = {
    id: `crash-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    timestamp: new Date().toISOString(),
    error: error.message,
    stack: error.stack,
    context: sanitizeContext(context) || {},
    recoveryAction
  };
  crashReports.push(report);
  
  if (crashReports.length > 100) {
    crashReports = crashReports.slice(-100);
  }
  
  try {
    const crashFile = path.join(LOG_DIR, `crash-${Date.now()}.json`);
    fs.writeFileSync(crashFile, JSON.stringify(report, null, 2));
  } catch (err) {
    console.error("Failed to write crash report:", err);
  }
}

export function clearBugPredictions(): void {
  bugPredictions.clear();
  errorCounts.clear();
}

export function getSystemHealth(): {
  errorRate: number;
  recentErrors: string[];
  bugPredictions: BugPrediction[];
  uptime: number;
  memoryUsage: number;
} {
  const recentLogs = getDebugLogs(1);
  const errors = recentLogs.filter(l => l.level === "error" || l.level === "critical");
  const total = recentLogs.length || 1;
  
  return {
    errorRate: (errors.length / total) * 100,
    recentErrors: errors.slice(-10).map(e => e.message),
    bugPredictions: getBugPredictions(),
    uptime: process.uptime(),
    memoryUsage: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
  };
}

export function closeLogger(): void {
  if (logStream) {
    logStream.end();
    logStream = null;
  }
}
