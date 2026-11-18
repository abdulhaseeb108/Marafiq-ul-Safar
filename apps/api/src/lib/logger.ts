/**
 * Structured logs (docs/01 section 9). One line per event: JSON in
 * production so a log service can search it, readable text in development.
 *
 * Never pass personal data (names, phones, emails, IPs), tokens, request
 * bodies, URLs that may carry a quote token, or raw error messages from the
 * database driver. Use ids, codes, counts and error names.
 */

type Level = 'info' | 'warn' | 'error';
export type LogFields = Record<string, string | number | boolean | null | undefined>;

interface LoggerOptions {
  /** JSON lines (production) or `level message key=value` text (development). */
  json: boolean;
  /** Tests stay quiet unless a test turns logging on. */
  silent: boolean;
}

let options: LoggerOptions = {
  json: process.env.NODE_ENV === 'production',
  silent: process.env.NODE_ENV === 'test',
};

/** Writes one line. Replaced in tests to capture output. */
let write = (level: Level, line: string): void => {
  (level === 'info' ? process.stdout : process.stderr).write(`${line}\n`);
};

export function configureLogger(next: Partial<LoggerOptions>): void {
  options = { ...options, ...next };
}

/** For tests: capture lines instead of printing them. Returns a restore function. */
export function captureLogs(sink: (level: Level, line: string) => void): () => void {
  const previous = { write, options };
  write = sink;
  options = { ...options, silent: false };
  return () => {
    write = previous.write;
    options = previous.options;
  };
}

function emit(level: Level, message: string, fields: LogFields = {}): void {
  if (options.silent) return;
  const defined = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (options.json) {
    write(
      level,
      JSON.stringify({
        time: new Date().toISOString(),
        level,
        msg: message,
        ...Object.fromEntries(defined),
      }),
    );
    return;
  }
  const extra = defined.map(([key, value]) => `${key}=${String(value)}`).join(' ');
  write(level, `${level.toUpperCase()} ${message}${extra ? ` ${extra}` : ''}`);
}

export const log = {
  info: (message: string, fields?: LogFields) => emit('info', message, fields),
  warn: (message: string, fields?: LogFields) => emit('warn', message, fields),
  error: (message: string, fields?: LogFields) => emit('error', message, fields),
};

/** The error's class name only; messages can carry values from the request. */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}
