/**
 * Single origin. The Worker serves the SPA and /api/* from the same host, so
 * every request is relative and there is no URL to configure.
 *
 * Deliberately a plain empty string, not `import.meta.env.VITE_API_URL || ''`.
 * The old form ended in `|| 'http://localhost:5050'`, and an empty string is
 * falsy — so setting VITE_API_URL='' to mean "same origin" would have silently
 * resolved back to localhost and pointed the production build at a machine that
 * does not exist. Deleting the variable deletes the trap.
 *
 * SIGNALR_URL is gone with SignalR itself; the signalling socket derives its
 * URL from window.location in wsService.
 */
export const API_URL = '';
