// In-memory ring buffer of recent server-side API errors, exposed via
// GET /api/logs so the client diagnostics report can include them. Nothing
// is persisted and the buffer resets on restart — it exists purely for
// "copy the log and get a diagnosis" support, not auditing.
const MAX_ENTRIES = 100;
const entries = [];

export function recordServerError(entry) {
  entries.push({ time: new Date().toISOString(), ...entry });
  if (entries.length > MAX_ENTRIES) entries.shift();
}

export function getServerErrors() {
  return entries.map(({ ...e }) => e);
}
