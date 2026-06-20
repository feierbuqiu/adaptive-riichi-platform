// OPS-003: cooperative single-leader election for background jobs.
//
// When two application revisions overlap during a zero-downtime deploy, only one of them
// should run singleton background jobs (the attempt sweeper, the cluster rebuild). A holder
// renews a heartbeat; a lock whose heartbeat is older than the TTL is considered stale and
// can be taken over by another instance. Callers fail open (run the job) if the lock store
// errors, so a single instance never silently stops its background work.

function createJobLock(db, options = {}) {
  const instanceId = options.instanceId || `inst_${Math.random().toString(16).slice(2)}`;
  const nowMs = typeof options.nowMs === "function" ? options.nowMs : () => Date.now();
  const ttlMs = Number(options.ttlMs) || 90000;
  const iso = (ms) => new Date(ms).toISOString();

  // Atomic acquire-or-renew: insert if absent; otherwise take it only when we already hold
  // it or its heartbeat has gone stale. A live other holder blocks the update.
  const upsert = db.prepare(`
    INSERT INTO job_locks (name, holder, acquired_at, heartbeat_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      holder = excluded.holder,
      heartbeat_at = excluded.heartbeat_at,
      acquired_at = CASE WHEN job_locks.holder = excluded.holder THEN job_locks.acquired_at ELSE excluded.acquired_at END
    WHERE job_locks.holder = excluded.holder OR job_locks.heartbeat_at <= ?
  `);
  const read = db.prepare("SELECT holder FROM job_locks WHERE name = ?");

  function acquire(name = "background") {
    const now = nowMs();
    const nowIso = iso(now);
    upsert.run(name, instanceId, nowIso, nowIso, iso(now - ttlMs));
    const row = read.get(name);
    return !!row && row.holder === instanceId;
  }

  return { instanceId, acquire };
}

module.exports = { createJobLock };
