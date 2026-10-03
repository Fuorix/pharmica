export type LogContext = Record<string, string | number | boolean | undefined>;

export function logInfo(message: string, context: LogContext = {}): void {
  console.info(JSON.stringify({ level: "info", message, ...context }));
}

export function logError(message: string, context: LogContext = {}): void {
  console.error(JSON.stringify({ level: "error", message, ...context }));
}
