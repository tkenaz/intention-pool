// Static guards over schema.sql. They need no database: they protect the
// properties the README promises (semantic search works on a clean install,
// audit history is append-only and covers every mutable table).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = await readFile(path.join(here, '../src/database/schema.sql'), 'utf-8');

const AUDITED_TABLES = [
  'intentions', 'intention_evolution', 'journeys', 'milestones',
  'progress_log', 'next_steps', 'artifacts', 'insights', 'blockers',
];

test('clean install gets pgvector, the embedding column and its index', () => {
  assert.match(schema, /CREATE EXTENSION IF NOT EXISTS vector;/);
  assert.match(schema, /ADD COLUMN IF NOT EXISTS embedding vector\(384\)/);
  assert.match(schema, /USING hnsw \(embedding vector_cosine_ops\)/);
});

test('the extension is created before anything uses the vector type', () => {
  assert.ok(schema.indexOf('CREATE EXTENSION IF NOT EXISTS vector') < schema.indexOf('vector(384)'));
});

test('embedding dimension matches the model the embedder loads', async () => {
  const embedder = await readFile(path.join(here, '../src/embeddings/embedder.js'), 'utf-8');
  assert.match(embedder, /all-MiniLM-L6-v2/); // 384-dim model
});

test('audit log is guarded by triggers, not only by grants', () => {
  assert.match(schema, /BEFORE INSERT OR UPDATE OR DELETE ON intention_audit_log/);
  assert.match(schema, /BEFORE TRUNCATE ON intention_audit_log/);
  assert.match(schema, /pg_trigger_depth\(\) < 2/);
});

test('actor identity comes from server-side settings, with an explicit fallback', () => {
  assert.match(schema, /current_setting\('app\.actor_model', true\)/);
  assert.match(schema, /current_setting\('app\.actor_client', true\)/);
  assert.match(schema, /'unknown'/);
});

test('every mutable table is wired to the audit trigger', () => {
  const block = schema.match(/FOREACH audited_table IN ARRAY ARRAY\[([\s\S]*?)\]/);
  assert.ok(block, 'audited table list not found');
  const listed = [...block[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
  assert.deepEqual([...listed].sort(), [...AUDITED_TABLES].sort());
  assert.match(schema, /AFTER INSERT OR UPDATE OR DELETE ON %I/);
});

test('every audited table actually exists in the schema', () => {
  for (const table of AUDITED_TABLES) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`), table);
  }
});

test('schema is idempotent: no bare CREATE TABLE / CREATE INDEX', () => {
  const bare = schema.match(/CREATE (TABLE|INDEX) (?!IF NOT EXISTS)/g);
  assert.equal(bare, null);
});
