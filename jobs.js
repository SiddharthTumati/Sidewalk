// A small background-job runner. Work that can happen later (sending notifications,
// follow-ups, cleanup) is saved as a row and run by a timer, so requests return quickly
// and nothing is lost if the server restarts.
const MAX_ATTEMPTS = 5;

function createJobs(db, { tickMs = 5000 } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      run_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      done_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS jobs_due_idx ON jobs(done_at, run_at);
  `);

  const handlers = new Map();
  const recurring = [];
  const timers = [];
  let running = false;

  function register(kind, handler) {
    handlers.set(kind, handler);
  }

  function schedule(kind, payload = {}, runAt = Date.now()) {
    if (!handlers.has(kind)) throw new Error(`No job handler for "${kind}"`);
    db.prepare('INSERT INTO jobs (kind, payload, run_at, created_at) VALUES (?, ?, ?, ?)')
      .run(kind, JSON.stringify(payload), runAt, Date.now());
    setImmediate(tick); // start promptly instead of waiting for the next tick
  }

  // Repeating work (threshold checks, cleanup). Runs in memory; it restarts with the server.
  function every(name, ms, fn) {
    recurring.push({ name, ms, fn });
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const due = db.prepare('SELECT * FROM jobs WHERE done_at IS NULL AND run_at <= ? ORDER BY run_at LIMIT 20').all(Date.now());
      for (const job of due) {
        const handler = handlers.get(job.kind);
        try {
          if (!handler) throw new Error(`No handler for "${job.kind}"`);
          await handler(JSON.parse(job.payload));
          db.prepare('UPDATE jobs SET done_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?').run(Date.now(), job.id);
        } catch (error) {
          const attempts = job.attempts + 1;
          const giveUp = attempts >= MAX_ATTEMPTS;
          // Retry after 1, 2, 4, 8 minutes, then give up and keep the error for debugging.
          db.prepare('UPDATE jobs SET attempts = ?, last_error = ?, run_at = ?, done_at = ? WHERE id = ?')
            .run(attempts, String(error.message || error).slice(0, 500), Date.now() + 60_000 * 2 ** (attempts - 1), giveUp ? Date.now() : null, job.id);
          console.error(`Job ${job.kind} #${job.id} failed (attempt ${attempts}${giveUp ? ', giving up' : ''}):`, error.message);
        }
      }
    } finally {
      running = false;
    }
  }

  function start() {
    timers.push(setInterval(tick, tickMs));
    for (const task of recurring) {
      timers.push(setInterval(async () => {
        try { await task.fn(); } catch (error) { console.error(`Recurring task ${task.name} failed:`, error.message); }
      }, task.ms));
    }
    timers.forEach((timer) => timer.unref());
    setImmediate(tick);
  }

  function stop() {
    timers.splice(0).forEach(clearInterval);
  }

  // Old finished jobs are removed after a week.
  every('jobs-cleanup', 60 * 60 * 1000, () => {
    db.prepare('DELETE FROM jobs WHERE done_at IS NOT NULL AND done_at < ?').run(Date.now() - 7 * 24 * 60 * 60 * 1000);
  });

  return { register, schedule, every, start, stop, tick };
}

module.exports = { createJobs };
