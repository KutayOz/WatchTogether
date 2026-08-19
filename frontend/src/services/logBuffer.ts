/**
 * The last few minutes of log lines, kept in memory so a bug report can carry
 * them.
 *
 * The things this app already logs are exactly the things a support case needs
 * and nobody ever has: the ICE candidate dump on a TCP-relayed path, the codec
 * fallback, a `setParameters` the browser refused. They go to `console`, which
 * means they exist only for someone who had DevTools open BEFORE the problem
 * started — and nobody does. Holding them lets the report include what already
 * happened rather than only what is happening now.
 *
 * A ring buffer and not an array that grows: a session runs for hours, and an
 * unbounded log is a leak with a nice name.
 */

/** Roughly the last few minutes of a normal session, and a hard bound on memory. */
export const LOG_BUFFER_SIZE = 200;

/** One line, with the level so a report can show what was a warning. */
export interface LogLine {
  at: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  text: string;
}

/**
 * One argument, as text.
 *
 * Errors first, because `String(error)` on an Error gives "Error: message" and
 * loses nothing, while JSON.stringify gives `{}` — the single most common way a
 * log line ends up saying nothing at all. Objects are stringified but bounded:
 * a whole RTCStatsReport pasted into a bug report drowns the line that matters.
 */
function render(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'object') {
    try {
      const json = JSON.stringify(value);
      return json.length > 300 ? `${json.slice(0, 300)}…` : json;
    } catch {
      return '[unserialisable]';
    }
  }
  return String(value);
}

class LogBuffer {
  private lines: LogLine[] = [];

  /** @param at Passed in rather than read here, so the buffer stays testable. */
  push(level: LogLine['level'], args: unknown[], at: number): void {
    this.lines.push({ at, level, text: args.map(render).join(' ') });
    if (this.lines.length > LOG_BUFFER_SIZE) {
      this.lines.splice(0, this.lines.length - LOG_BUFFER_SIZE);
    }
  }

  /** A copy, oldest first. Callers format; this one only remembers. */
  snapshot(): LogLine[] {
    return [...this.lines];
  }

  clear(): void {
    this.lines = [];
  }
}

export const logBuffer = new LogBuffer();
