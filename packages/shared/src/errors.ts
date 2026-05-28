/**
 * Typed error hierarchy. Keeps cross-package error handling exhaustive and avoids
 * stringly-typed checks like `err.message.includes("...")`.
 */

export class CcbError extends Error {
  readonly code: string;
  override readonly cause?: unknown;
  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.cause = cause;
  }
}

export class ValidationError extends CcbError {
  constructor(message: string, cause?: unknown) {
    super("VALIDATION_FAILED", message, cause);
  }
}

export class NotFoundError extends CcbError {
  constructor(resource: string, id: string) {
    super("NOT_FOUND", `${resource} not found: ${id}`);
  }
}

export class PermissionError extends CcbError {
  constructor(message: string) {
    super("PERMISSION_DENIED", message);
  }
}

export class TimeoutError extends CcbError {
  constructor(message: string) {
    super("TIMEOUT", message);
  }
}

export class ShellError extends CcbError {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  constructor(message: string, opts: { stdout: string; stderr: string; exitCode: number | null }) {
    super("SHELL_FAILED", message);
    this.stdout = opts.stdout;
    this.stderr = opts.stderr;
    this.exitCode = opts.exitCode;
  }
}

export class TaskCancelledError extends CcbError {
  constructor(taskId: string) {
    super("TASK_CANCELLED", `Task ${taskId} was cancelled`);
  }
}

export function isCcbError(e: unknown): e is CcbError {
  return e instanceof CcbError;
}
