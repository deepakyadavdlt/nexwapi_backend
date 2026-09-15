/**
 * In-memory WhatsApp call signaling (SDP / ringing) from Meta webhooks → dashboard.
 * Single-process. Events expire after 3 minutes.
 */
const TTL_MS = 3 * 60 * 1000;
const MAX = 80;

let seq = 1;
const queues = new Map();
const waiters = new Map();

function prune(companyId) {
  const cut = Date.now() - TTL_MS;
  const next = (queues.get(companyId) || []).filter((e) => e.at > cut).slice(-MAX);
  if (next.length) queues.set(companyId, next);
  else queues.delete(companyId);
  return next;
}

export function pushCallSignal(companyId, payload) {
  if (!companyId) return null;
  const event = { id: seq++, at: Date.now(), ...payload };
  const q = prune(companyId);
  q.push(event);
  queues.set(companyId, q.slice(-MAX));
  const pending = waiters.get(companyId) || [];
  waiters.set(companyId, []);
  for (const w of pending) {
    try {
      w.resolve(q.filter((e) => e.id > w.after));
    } catch {
      /* ignore */
    }
  }
  return event;
}

export function takeCallSignals(companyId, after = 0, waitMs = 0, req) {
  prune(companyId);
  const ready = (queues.get(companyId) || []).filter((e) => e.id > after);
  if (ready.length || !waitMs) return Promise.resolve(ready);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (events) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (req) req.off("close", onClose);
      const list = waiters.get(companyId) || [];
      waiters.set(companyId, list.filter((w) => w !== entry));
      resolve(events);
    };
    const entry = { after, resolve: (events) => finish(events) };
    const timer = setTimeout(() => finish([]), waitMs);
    const onClose = () => finish([]);
    const list = waiters.get(companyId) || [];
    list.push(entry);
    waiters.set(companyId, list);
    if (req) req.on("close", onClose);
  });
}
