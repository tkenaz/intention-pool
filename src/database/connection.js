import pg from 'pg';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from the repo root regardless of the cwd the MCP host spawned us from.
// Values already present in the environment (e.g. from the host config) take precedence.
dotenv.config({ path: path.join(__dirname, '../../.env') });

const { Pool } = pg;

const sanitizeActor = (value, fallback) => {
  const normalized = String(value || fallback).trim();
  return /^[A-Za-z0-9_.-]+$/.test(normalized) ? normalized : fallback;
};

const actorModel = sanitizeActor(process.env.ACTOR_MODEL, 'unknown');
const actorClient = sanitizeActor(process.env.ACTOR_CLIENT, 'unknown');

// Create connection pool
export const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: process.env.PG_PORT || 5432,
  database: process.env.PG_DB || 'intention_pool',
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD,
  // PostgreSQL custom settings are visible to the audit trigger on every
  // connection and cannot be spoofed through MCP tool arguments.
  options: `-c app.actor_model=${actorModel} -c app.actor_client=${actorClient}`,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test connection
pool.on('connect', () => {
  console.error('Database connected successfully');
});

pool.on('error', (err) => {
  console.error('Unexpected database error:', err);
});

/**
 * Initialize database schema
 */
export async function initializeDatabase() {
  try {
    // AUTO_MIGRATE=false -> running as a least-privilege runtime role with no DDL
    // rights; skip schema application. An owner role applies migrations separately.
    if (process.env.AUTO_MIGRATE === 'false') {
      await pool.query('SELECT 1');
      console.error('AUTO_MIGRATE=false — skipping schema DDL (runtime role)');
      return true;
    }

    // Read schema file
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = await fs.readFile(schemaPath, 'utf-8');

    // Execute schema
    await pool.query(schema);
    console.error('Database schema initialized');

    // Migrate existing JSON data if needed
    await migrateExistingData();

    return true;
  } catch (error) {
    console.error('Failed to initialize database:', error);
    throw error;
  }
}

/**
 * Migrate existing JSON data to PostgreSQL
 */
async function migrateExistingData() {
  try {
    const dataDir = path.join(__dirname, '../../data');
    const statuses = ['active', 'suspended', 'fulfilled', 'abandoned'];

    for (const status of statuses) {
      const statusDir = path.join(dataDir, status);

      try {
        const files = await fs.readdir(statusDir);

        for (const file of files) {
          if (file.endsWith('.json')) {
            const content = await fs.readFile(path.join(statusDir, file), 'utf-8');
            const intention = JSON.parse(content);

            // Check if already migrated
            const existing = await pool.query(
              'SELECT id FROM intentions WHERE id = $1',
              [intention.id]
            );

            if (existing.rows.length === 0) {
              // Migrate intention
              await migrateIntention(intention);
              console.error(`Migrated intention: ${intention.id}`);
            }
          }
        }
      } catch (error) {
        // Directory might not exist
        if (error.code !== 'ENOENT') {
          console.error(`Error migrating ${status} intentions:`, error);
        }
      }
    }
  } catch (error) {
    console.error('Migration error:', error);
  }
}

/**
 * Migrate single intention to database
 */
async function migrateIntention(intention) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Insert main intention
    await client.query(
      `INSERT INTO intentions (id, content, energy, status, context, parent_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO NOTHING`,
      [
        intention.id,
        intention.content,
        intention.energy,
        intention.status,
        JSON.stringify(intention.context || {}),
        intention.parent_id,
        intention.created_at,
        intention.updated_at
      ]
    );

    // Insert evolution history
    if (intention.evolution_history && intention.evolution_history.length > 0) {
      for (const evolution of intention.evolution_history) {
        await client.query(
          `INSERT INTO intention_evolution (intention_id, old_content, old_energy, notes, timestamp)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            intention.id,
            evolution.old_content,
            evolution.old_energy,
            evolution.notes,
            evolution.timestamp
          ]
        );
      }
    }

    // Insert children relationships
    if (intention.children_ids && intention.children_ids.length > 0) {
      for (const childId of intention.children_ids) {
        await client.query(
          `INSERT INTO intention_children (parent_id, child_id)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [intention.id, childId]
        );
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Execute query with automatic reconnection
 */
export async function query(text, params) {
  try {
    const result = await pool.query(text, params);
    return result;
  } catch (error) {
    console.error('Query error:', error);
    throw error;
  }
}

export async function getIntentionAudit(intentionId, limit = 50) {
  const result = await query(
    `SELECT id, entity_type, entity_id, operation, actor_model, actor_client,
            changed_at, old_data, new_data
       FROM intention_audit_log
      WHERE intention_id = $1
      ORDER BY changed_at DESC, id DESC
      LIMIT $2`,
    [intentionId, limit]
  );
  return result.rows;
}

/**
 * Get a client for transactions
 */
export async function getClient() {
  return await pool.connect();
}

/**
 * Close all connections
 */
export async function closeDatabase() {
  await pool.end();
}
