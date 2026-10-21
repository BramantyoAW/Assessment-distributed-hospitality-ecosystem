/**
 * Structured JSON-lines logger.
 *
 * Deliberately duplicated from Module 1: the two modules are separate
 * processes, deployed and restarted independently, and a shared package would
 * couple their release cycles for ~40 lines of code.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  readonly service: string;
  readonly minLevel?: LogLevel;
  readonly sink?: (line: string) => void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(options: LoggerOptions): Logger {
  const minLevel = options.minLevel ?? 'info';
  const sink =
    options.sink ??
    ((line: string): void => {
      process.stdout.write(`${line}\n`);
    });

  const emit = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (ORDER[level] < ORDER[minLevel]) return;
    sink(
      JSON.stringify({
        ts: new Date().toISOString(),
        level,
        service: options.service,
        message,
        ...fields,
      }),
    );
  };

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}
