// Pure-logic tests for the hybrid searcher. Importing the module builds a pg
// Pool but opens no connection, so these run without a database.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { HybridIntentionSearcher, combineScores, VECTOR_WEIGHT, KEYWORD_WEIGHT } from '../src/core/hybrid-searcher.js';
import { pool } from '../src/database/connection.js';

after(() => pool.end());

const searcher = new HybridIntentionSearcher();

test('extractKeywords lowercases and drops short words', () => {
  assert.deepEqual(searcher.extractKeywords('Ship the MCP server to QA'), ['ship', 'mcp', 'server']);
});

test('extractKeywords drops English and Russian stop words', () => {
  assert.deepEqual(searcher.extractKeywords('plan for the release with tests'), ['plan', 'release', 'tests']);
  assert.deepEqual(searcher.extractKeywords('план для релиза'), ['план', 'релиза']);
});

test('extractKeywords returns nothing for an empty or all-stop-word query', () => {
  assert.deepEqual(searcher.extractKeywords(''), []);
  assert.deepEqual(searcher.extractKeywords('the for a in'), []);
});

test('extractKeywords collapses arbitrary whitespace', () => {
  assert.deepEqual(searcher.extractKeywords('  audit\tlog \n provenance '), ['audit', 'log', 'provenance']);
});

test('combineScores puts all three cases on one scale', () => {
  assert.equal(combineScores(1, 1), VECTOR_WEIGHT + KEYWORD_WEIGHT);
  assert.equal(combineScores(0.5, 0), VECTOR_WEIGHT * 0.5);
  assert.equal(combineScores(0, 0.5), KEYWORD_WEIGHT * 0.5);
  assert.equal(combineScores(), 0);
});

test('extra evidence never lowers a score', () => {
  for (const v of [0, 0.3, 0.7, 1]) {
    for (const k of [0, 0.5, 1]) {
      assert.ok(combineScores(v, k) >= combineScores(v, 0), `keyword evidence lowered v=${v} k=${k}`);
      assert.ok(combineScores(v, k) >= combineScores(0, k), `vector evidence lowered v=${v} k=${k}`);
    }
  }
});
