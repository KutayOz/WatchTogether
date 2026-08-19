/**
 * Tiny logging shim. `debug`/`info` traces are silenced in production builds so
 * the browser console stays clean and we don't leak WebRTC/SignalR connection
 * chatter to end users; `warn`/`error` always surface because they're
 * low-frequency and operationally useful. Centralizing here means we can later
 * route logs to a remote sink without touching every call site.
 */
import { logBuffer } from './logBuffer';

const isDev = import.meta.env.DEV;

type LogFn = (...args: unknown[]) => void;

/**
 * Every line also goes to `logBuffer`, including the debug traces that are
 * silent in production.
 *
 * Silent in the CONSOLE, that is. The reason to keep them anyway is that the
 * lines this app writes are the ones a support case actually needs — the ICE
 * candidate dump on a TCP-relayed path, the codec fallback, a `setParameters`
 * the browser refused — and a console is only useful to someone who had
 * DevTools open before the problem began. Nobody does. The buffer is bounded
 * and never leaves the machine unless a person copies the report themselves.
 */
function record(level: 'debug' | 'info' | 'warn' | 'error', sink: LogFn): LogFn {
  return (...args: unknown[]) => {
    logBuffer.push(level, args, Date.now());
    sink(...args);
  };
}

const quiet: LogFn = () => {};

export const logger: { debug: LogFn; info: LogFn; warn: LogFn; error: LogFn } = {
  debug: record('debug', isDev ? (...args) => console.log(...args) : quiet),
  info: record('info', isDev ? (...args) => console.info(...args) : quiet),
  warn: record('warn', (...args) => console.warn(...args)),
  error: record('error', (...args) => console.error(...args)),
};
