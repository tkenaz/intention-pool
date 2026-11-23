// End-to-end tests against a real PostgreSQL + pgvector.
//
// Skipped unless TEST_PG_DB is set. They create and mutate rows, so point them
// at a throwaway database only (the name must contain "test"):
//
//   docker run -d --rm --name pool-test -e POSTGRES_PASSWORD=test \
//     -e POSTGRES_DB=intention_pool_test -p 127.0.0.1:55432:5432 pgvector/pgvector:pg16
//   TEST_PG_DB=intention_pool_test TEST_PG_PORT=55432 TEST_PG_PASSWORD=test npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const dbName = process.env.TEST_PG_DB;
const enabled = Boolean(dbName);
const opts = { skip: enabled ? false : 'set TEST_PG_DB to run database tests' };

if (enabled && !/test/i.test(dbName)) {
  throw new Error(`Refusing to run against "${dbName}": database name must contain "test"`);
}

let db, manager, searcher, embedder, pg;

before(async () => {
  if (!enabled) return;
  // connection.js reads PG_* at import time, so set them before importing.
  process.env.PG_DB = dbName;
  process.env.PG_HOST = process.env.TEST_PG_HOST || 'localhost';
  process.env.PG_PORT = process.env.TEST_PG_PORT || '5432';
  process.env.PG_USER = process.env.TEST_PG_USER || 'postgres';
  process.env.PG_PASSWORD = process.env.TEST_PG_PASSWORD || '';
  process.env.ACTOR_MODEL = 'test-model';
  process.env.ACTOR_CLIENT = 'test-client';
  delete process.env.AUTO_MIGRATE;

  pg = (await import('pg')).default;
  db = await import('../src/database/connection.js');
  ({ embedder } = await import('../src/embeddings/embedder.js'));
  const { IntentionManager } = await import('../src/core/intention-manager-pg.js');
  ({ hybridSearcher: searcher } = await import('../src/core/hybrid-searcher.js'));
  manager = new IntentionManager();

  await db.initializeDatabase();
  await db.initializeDatabase(); // applying the schema twice must be harmless
});

after(async () => {
  if (enabled) await db.closeDatabase();
});

// createIntention() embeds in the background; wait for the row to get its vector.
async function waitForEmbedding(id, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await db.query('SELECT embedding IS NOT NULL AS ok FROM intentions WHERE id = $1', [id]);
    if (r.rows[0]?.ok) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`embedding for ${id} was not written within ${timeoutMs} ms`);
}

test('clean install has pgvector and a 384-dim embedding column', opts, async () => {
  const r = await db.query(
    `SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
      WHERE attrelid = 'intentions'::regclass AND attname = 'embedding'`
  );
  assert.equal(r.rows[0].type, 'vector(384)');
});

test('lifecycle: create, evolve, fulfill; history and energy clamp are kept', opts, async () => {
  const created = await manager.createIntention({
    content: 'Ship the quarterly billing export',
    energy: 0.9,
    context: { project: 'billing' },
  });
  assert.equal(created.status, 'active');

  const evolved = await manager.evolveIntention(created.id, {
    new_content: 'Ship the quarterly billing export as CSV and PDF',
    energy_delta: 0.5, // 0.9 + 0.5 must clamp to 1
    notes: 'PDF requested by finance',
  });
  assert.equal(Number(evolved.energy), 1);
  assert.match(evolved.content, /CSV and PDF/);

  const history = await db.query(
    'SELECT old_content, notes FROM intention_evolution WHERE intention_id = $1',
    [created.id]
  );
  assert.equal(history.rows.length, 1);
  assert.equal(history.rows[0].old_content, 'Ship the quarterly billing export');

  await manager.fulfillIntention(created.id, 'delivered');
  const final = await db.query('SELECT status FROM intentions WHERE id = $1', [created.id]);
  assert.equal(final.rows[0].status, 'fulfilled');
});

test('audit log records every change with the server-side actor', opts, async () => {
  const created = await manager.createIntention({ content: 'Rotate the staging API keys' });
  await manager.evolveIntention(created.id, { energy_delta: -0.1, notes: 'deprioritised' });

  const events = await db.getIntentionAudit(created.id);
  const onIntention = events.filter(e => e.entity_type === 'intentions');
  assert.ok(onIntention.some(e => e.operation === 'INSERT'));
  assert.ok(onIntention.some(e => e.operation === 'UPDATE'));
  assert.ok(events.some(e => e.entity_type === 'intention_evolution'));
  for (const e of events) {
    assert.equal(e.actor_model, 'test-model');
    assert.equal(e.actor_client, 'test-client');
  }
  const update = onIntention.find(e => e.operation === 'UPDATE' && e.old_data && e.new_data);
  assert.ok(update, 'UPDATE event keeps both old and new row');
});

test('audit log cannot be rewritten or forged, even by a role granted ALL on it', opts, async () => {
  const role = 'pool_runtime_test';
  await db.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
  await db.query(`CREATE ROLE ${role} LOGIN PASSWORD 'runtime'`);
  // The careless-operator case: blanket privileges, including on the log itself.
  await db.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${role}`);
  await db.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${role}`);

  const runtime = new pg.Client({
    host: process.env.PG_HOST, port: process.env.PG_PORT, database: dbName,
    user: role, password: 'runtime',
  });
  await runtime.connect();
  try {
    const read = await runtime.query('SELECT count(*)::int AS n FROM intention_audit_log');
    assert.ok(read.rows[0].n > 0);
    await assert.rejects(runtime.query("UPDATE intention_audit_log SET actor_model = 'forged'"), /append-only/);
    await assert.rejects(runtime.query('DELETE FROM intention_audit_log'), /append-only/);
    await assert.rejects(runtime.query('TRUNCATE intention_audit_log'), /append-only/);
    await assert.rejects(
      runtime.query(
        `INSERT INTO intention_audit_log (entity_type, operation, actor_model, actor_client)
         VALUES ('intentions', 'UPDATE', 'forged', 'forged')`
      ),
      /written only by the audit trigger/
    );
    const after = await runtime.query('SELECT count(*)::int AS n FROM intention_audit_log');
    assert.equal(after.rows[0].n, read.rows[0].n);

    // The same role can still do ordinary work, and that work is audited.
    await runtime.query("INSERT INTO intentions (id, content) VALUES ('int_runtime_role', 'written by the runtime role')");
    const audited = await runtime.query("SELECT count(*)::int AS n FROM intention_audit_log WHERE intention_id = 'int_runtime_role'");
    assert.equal(audited.rows[0].n, 1);
  } finally {
    await runtime.end();
    await db.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`);
    await db.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${role}`);
    await db.query(`DROP ROLE ${role}`);
  }
});

test('the owner connection cannot edit the log either while the guard is in place', opts, async () => {
  await assert.rejects(db.query("UPDATE intention_audit_log SET actor_model = 'forged'"), /append-only/);
  await assert.rejects(db.query('DELETE FROM intention_audit_log'), /append-only/);
});

test('hybrid search finds an intention by meaning and by keyword', opts, async () => {
  const target = await manager.createIntention({
    content: 'Migrate the customer database to a new PostgreSQL cluster',
    energy: 0.8,
  });
  const other = await manager.createIntention({
    content: 'Plan the team offsite in the mountains',
    energy: 0.8,
  });
  await waitForEmbedding(target.id);
  await waitForEmbedding(other.id);

  // No query word is a substring of the target, so only the vector side can rank it.
  const semantic = await searcher.searchHybrid('relocate records onto different machines', { limit: 2 });
  assert.equal(semantic[0].id, target.id);
  assert.equal(semantic[0].relevance.keyword_score, 0);
  assert.ok(semantic[0].relevance.vector_score > 0);

  const keyword = await searcher.searchHybrid('offsite mountains', { limit: 2 });
  assert.equal(keyword[0].id, other.id);
  assert.equal(keyword[0].relevance.keyword_score, 1);
});

test('fulfilled intentions drop out of search', opts, async () => {
  const done = await manager.createIntention({ content: 'Renew the wildcard TLS certificate', energy: 0.9 });
  await waitForEmbedding(done.id);
  await manager.fulfillIntention(done.id, 'renewed');
  const results = await searcher.searchHybrid('wildcard TLS certificate', { limit: 5 });
  assert.ok(!results.some(r => r.id === done.id));
});

test('a keyword found only in context still counts', opts, async () => {
  const tagged = await manager.createIntention({
    content: 'Write the onboarding guide',
    energy: 0.8,
    context: { project: 'zephyrdocs' },
  });
  await waitForEmbedding(tagged.id);
  const results = await searcher.searchHybrid('zephyrdocs', { limit: 3 });
  const hit = results.find(r => r.id === tagged.id);
  assert.ok(hit, 'row matched through context is returned');
  assert.equal(hit.relevance.keyword_score, 1);
});

test('a second signal never ranks a row below its single-signal score', opts, async () => {
  const both = await manager.createIntention({ content: 'Benchmark the vector index rebuild', energy: 0.8 });
  await waitForEmbedding(both.id);
  const [byBoth] = (await searcher.searchHybrid('benchmark the vector index rebuild', { limit: 5 }))
    .filter(r => r.id === both.id);
  assert.ok(byBoth.relevance.keyword_score > 0 && byBoth.relevance.vector_score > 0);
  assert.ok(byBoth.relevance.hybrid_score >= 0.2 * byBoth.relevance.vector_score);
  assert.ok(byBoth.relevance.hybrid_score >= 0.8 * byBoth.relevance.keyword_score);
});
