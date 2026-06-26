/**
 * Tiny logging shim. `debug`/`info` traces are silenced in production builds so
 * the browser console stays clean and we don't leak WebRTC/SignalR connection
 * chatter to end users; `warn`/`error` always surface because they're
 * low-frequency and operationally useful. Centralizing here means we can later
 * route logs to a remote sink without touching every call site.
 */
const isDev = import.meta.env.DEV;

type LogFn = (...args: unknown[]) => void;
const noop: LogFn = () => {};

export const logger: { debug: LogFn; info: LogFn; warn: LogFn; error: LogFn } = {
  debug: isDev ? (...args) => console.log(...args) : noop,
  info: isDev ? (...args) => console.info(...args) : noop,
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};
