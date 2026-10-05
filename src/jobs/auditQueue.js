/**
 * Audit job queue.
 *
 * Two modes:
 *   - REDIS_ENABLED=true  -> real BullMQ queue (needs Redis running, and a
 *                            separate `npm run worker` process). Use this in
 *                            production where audits must survive restarts.
 *   - REDIS_ENABLED=false -> in-memory queue (default). No Redis needed, no
 *                            separate worker process: `npm start` alone works.
 *                            Jobs are lost on restart, which is fine for dev.
 *
 * Both modes expose the same tiny interface the controller uses:
 *   queue.add(name, data) -> { id }
 *   queue.getJob(id)      -> { id, data, getState(), returnvalue } | null
 */

const USE_REDIS = String(process.env.REDIS_ENABLED || 'false').toLowerCase() === 'true';

let auditQueue;
let connection = null;

if (USE_REDIS) {
  const { Queue } = require('bullmq');
  const IORedis = require('ioredis');

  connection = new IORedis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: process.env.REDIS_PORT || 6379,
    maxRetriesPerRequest: null,
  });

  auditQueue = new Queue('audit-jobs', { connection });
  console.log('[queue] Using BullMQ + Redis. Remember to run `npm run worker` too.');
} else {
  // ---- In-memory queue ----
  const jobs = new Map();
  let nextId = 1;

  auditQueue = {
    async add(name, data) {
      const id = String(nextId++);
      const job = { id, name, data, state: 'active', returnvalue: null, progress: { pct: 0, message: 'Starting…', steps: {} } };
      jobs.set(id, job);

      // Run it in the background; the HTTP response has already been sent.
      // Required lazily to avoid a circular import at module load time.
      const { runFullAudit } = require('../controllers/audit.controller');
      runFullAudit(data.url, {
        maxPages: data.maxPages,
        onProgress: (p) => { job.progress = p; },
      })
        .then((result) => {
          job.returnvalue = result;
          job.state = 'completed';
          console.log(`[queue] Audit ${id} completed for ${data.url}`);
        })
        .catch((err) => {
          job.state = 'failed';
          job.failedReason = err.message;
          console.error(`[queue] Audit ${id} failed:`, err.message);
        });

      return job;
    },

    async getJob(id) {
      const job = jobs.get(String(id));
      if (!job) return null;
      return {
        id: job.id,
        data: job.data,
        returnvalue: job.returnvalue,
        failedReason: job.failedReason,
        progress: job.progress,
        getState: async () => job.state,
      };
    },
  };

  console.log('[queue] Using in-memory queue (no Redis needed).');
}

module.exports = { auditQueue, connection };
