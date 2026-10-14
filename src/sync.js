'use strict';
/**
 * Offline queue drain. Same guarantees as the SQLite version:
 * idempotent via (user_id, client_uuid), batched to Zoho's 100-record cap,
 * and failures park as 'failed' rather than disappearing.
 */
const zoho = require('./lib/zoho');
const { q, audit } = require('./db');
const { toZoho, M } = require('./domain');

const MAX_ATTEMPTS = 5;

function mapPayload(module, payload) {
  switch (module) {
    case M.ACTIVITY: return toZoho.activity(payload);
    case M.RING:     return toZoho.ring(payload);
    case M.MEETING:  return toZoho.meeting(payload);
    case M.CONTACT:  return toZoho.member(payload);
    default:         return payload;
  }
}

async function flushQueue({ limit = 200 } = {}) {
  const items = await q.pending(limit);
  if (!items.length) return { processed: 0, ok: 0, failed: 0 };

  const byModule = new Map();
  for (const item of items) {
    if (!byModule.has(item.module)) byModule.set(item.module, []);
    byModule.get(item.module).push(item);
  }

  let ok = 0, failed = 0;

  for (const [module, group] of byModule) {
    const inserts = group.filter(g => g.op === 'insert' || g.op === 'upsert');
    const updates = group.filter(g => g.op === 'update');

    for (const [op, list] of [['insert', inserts], ['update', updates]]) {
      if (!list.length) continue;
      try {
        const records = list.map(i => mapPayload(module, JSON.parse(i.payload)));
        const res = op === 'insert'
          ? await zoho.insertRecords(module, records)
          : await zoho.updateRecords(module, records);

        for (let i = 0; i < list.length; i++) {
          const item = list[i], r = res[i];
          if (r && (r.code === 'SUCCESS' || r.status === 'success')) {
            await q.markDone(r.details?.id || null, item.id);
            ok++;
          } else {
            const status = item.attempts + 1 >= MAX_ATTEMPTS ? 'failed' : 'pending';
            await q.markFailed(status, r?.message || 'Unknown Zoho response', item.id);
            failed++;
          }
        }
      } catch (err) {
        for (const item of list) {
          const status = item.attempts + 1 >= MAX_ATTEMPTS ? 'failed' : 'pending';
          await q.markFailed(status, String(err.message || 'error').slice(0, 500), item.id);
          failed++;
        }
        console.error(`[sync] ${module}/${op} batch failed:`, err.message);
      }
    }
  }

  await audit(null, 'sync.flush', { processed: items.length, ok, failed });
  return { processed: items.length, ok, failed };
}

async function enqueue({ userId, clientUuid, module, op, payload }) {
  // Check first rather than relying on RETURNING behaviour with ON CONFLICT,
  // which differs between drivers. One indexed lookup, deterministic result.
  const existing = await q.byClientUuid(userId, clientUuid);
  if (existing) return { duplicate: true, id: existing.id, status: existing.status };

  const rows = await q.enqueue(userId, clientUuid, module, op, JSON.stringify(payload));
  if (!rows.length) {
    // Lost a race with a concurrent identical push — still a duplicate
    const now = await q.byClientUuid(userId, clientUuid);
    return { duplicate: true, id: now?.id, status: now?.status };
  }
  return { duplicate: false, id: rows[0].id, status: 'pending' };
}

module.exports = { flushQueue, enqueue, mapPayload };
