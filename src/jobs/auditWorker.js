require('dotenv').config();

const USE_REDIS = String(process.env.REDIS_ENABLED || 'false').toLowerCase() === 'true';

if (!USE_REDIS) {
  console.log(
    'REDIS_ENABLED is not true, so the app is running the in-memory queue.\n' +
      'Audits already run inside `npm start` — this worker process is not needed.\n' +
      'Set REDIS_ENABLED=true in .env (and have Redis running) if you want the BullMQ worker.'
  );
  process.exit(0);
}

const { Worker } = require('bullmq');
const { connection } = require('./auditQueue');
const { runFullAudit } = require('../controllers/audit.controller');

const worker = new Worker(
  'audit-jobs',
  async (job) => {
    const { url } = job.data;
    console.log(`[worker] Running full audit for ${url}`);
    return runFullAudit(url, {
      maxPages: job.data.maxPages,
      onProgress: (p) => job.updateProgress(p).catch(() => {}),
    });
  },
  { connection, concurrency: 3 }
);

worker.on('completed', (job) => {
  console.log(`[worker] Job ${job.id} completed for ${job.data.url}`);
});

worker.on('failed', (job, err) => {
  console.error(`[worker] Job ${job.id} failed:`, err.message);
});

console.log('Audit worker started, waiting for jobs...');
