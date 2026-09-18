// Runs the NDJSON export alone in its own process so the integration test can measure the
// memory of the exporter itself (the jest process starts near 300 MB before streaming anything).
// Usage: DATABASE_URL=... tsx stream-child.ts <tenant_id> <fields>. Prints `{lines, peakRssMb}`.
import 'reflect-metadata';
import { Writable } from 'node:stream';
import { ContactStreamService } from '../contact-stream.service.js';

const [tenantId, fields] = process.argv.slice(2) as [string, string];
let lines = 0;
let peak = 0;
const sample = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 50);

// A consumer slower than the database, so backpressure is what keeps memory flat.
const sink = new Writable({
  highWaterMark: 64 * 1024,
  write(chunk: Buffer, _enc, cb) {
    for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, i + 1)) lines++;
    setImmediate(cb);
  },
});

const service = new ContactStreamService();
service
  .stream(tenantId, fields.split(',').map(Number), undefined, sink)
  .then(async () => {
    clearInterval(sample);
    console.log(JSON.stringify({ lines, peakRssMb: Math.round(peak / 1048576) }));
    await service.onModuleDestroy();
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
