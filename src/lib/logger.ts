import crypto from "crypto";

type LogLevel = "info" | "warn" | "error" | "fatal";

type LogContext = {
  requestId?: string;
  endpoint?: string;
  userIpHash?: string;
  [key: string]: unknown;
};

function nowIso(): string {
  return new Date().toISOString();
}

function hashIp(ip: string): string {
  return crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

function extractClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() ?? "unknown";
  }
  return request.headers.get("x-real-ip") ?? "unknown";
}

function baseContext(level: LogLevel, message: string, context?: LogContext) {
  return {
    timestamp: nowIso(),
    level,
    message,
    ...context,
  };
}

function emit(level: LogLevel, message: string, context?: LogContext) {
  const payload = baseContext(level, message, context);

  if (level === "info") {
    console.log(JSON.stringify(payload));
    return;
  }
  if (level === "warn") {
    console.warn(JSON.stringify(payload));
    return;
  }
  console.error(JSON.stringify(payload));
}

export function getRequestLogContext(request: Request, endpoint?: string): LogContext {
  return {
    endpoint,
    requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
    userIpHash: hashIp(extractClientIp(request)),
  };
}

export const logger = {
  info(message: string, context?: LogContext) {
    emit("info", message, context);
  },
  warn(message: string, context?: LogContext) {
    emit("warn", message, context);
  },
  error(message: string, context?: LogContext) {
    emit("error", message, context);
  },
  fatal(message: string, context?: LogContext) {
    emit("fatal", message, context);
  },
};
