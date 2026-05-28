import pino, { type Logger, type LoggerOptions } from "pino";

const isProd = process.env.NODE_ENV === "production";

const baseOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: process.env.SERVICE_NAME ?? "ccb" },
  redact: {
    paths: [
      "*.token",
      "*.apiKey",
      "*.password",
      "*.secret",
      "headers.authorization",
      "headers.cookie",
      "env.DISCORD_TOKEN",
      "env.GITHUB_TOKEN",
      "env.ANTHROPIC_API_KEY",
    ],
    censor: "[REDACTED]",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

const devTransport = isProd
  ? undefined
  : {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "HH:MM:ss.l",
        ignore: "pid,hostname,service",
      },
    };

export const rootLogger: Logger = pino({
  ...baseOptions,
  ...(devTransport ? { transport: devTransport } : {}),
});

export function makeLogger(component: string, bindings: Record<string, unknown> = {}): Logger {
  return rootLogger.child({ component, ...bindings });
}

export type { Logger };
