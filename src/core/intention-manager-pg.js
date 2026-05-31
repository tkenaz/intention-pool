import { query, getClient } from '../database/connection.js';
import { embedder } from '../embeddings/embedder.js';

export class IntentionManager {
  /**
   * Create a new intention
   */
  async createIntention({ content, energy = 0.5, context = {}, parent_id = null }) {
    const id = `int_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const client = await getClient();

    try {
      await client.query('BEGIN');

      // Create intention
      await client.query(
        `INSERT INTO intentions (id, content, energy, status, context, parent_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, content, energy, 'active', JSON.stringify(context), parent_id]
      );

      // If has parent, add to children table
      if (parent_id) {
        await client.query(
          `INSERT INTO intention_children (parent_id, child_id)
           VALUES ($1, $2)`,
          [parent_id, id]
        );
      }

      await client.query('COMMIT');

      const intention = {
        id,
        content,
        energy,
        status: 'active',
        context,
        parent_id,
        created_at: new Date(),
        updated_at: new Date()
      };

      // Generate embedding asynchronously (не блокируем возврат)
      embedder.embedIntention(intention).catch(error => {
        console.error(`Failed to generate embedding for ${id}:`, error);
      });

      return intention;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get intentions with filters
   */
  async getIntentions({ status = 'all', min_energy = 0, limit = 20 }) {
    // Build WHERE clause
    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (status !== 'all') {
      whereClause += ` AND status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    if (min_energy > 0) {
      whereClause += ` AND energy >= $${paramIndex}`;
      params.push(min_energy);
      paramIndex++;
    }

    // Main query with subqueries for children and evolution
    const queryText = `
      SELECT
        i.id,
        i.content,
        i.energy,
        i.status,
        i.context,
        i.parent_id,
        i.created_at,
        i.updated_at,
        (
          SELECT array_agg(child_id)
          FROM intention_children
          WHERE parent_id = i.id
        ) as children_ids,
        (
          SELECT json_agg(
            json_build_object(
              'timestamp', timestamp,
              'old_content', old_content,
              'old_energy', old_energy,
              'notes', notes
            ) ORDER BY timestamp DESC
          )
          FROM intention_evolution
          WHERE intention_id = i.id
        ) as evolution_history
      FROM intentions i
      ${whereClause}
      ORDER BY i.energy DESC, i.updated_at DESC
      LIMIT $${paramIndex}
    `;
    params.push(limit);

    const result = await query(queryText, params);

    // Parse JSON fields and handle nulls
    return result.rows.map(row => ({
      ...row,
      context: typeof row.context === 'string' ? JSON.parse(row.context) : row.context,
      children_ids: row.children_ids || [],
      evolution_history: row.evolution_history || []
    }));
  }

  /**
   * Evolve an intention
   */
  async evolveIntention(intentionId, { new_content, energy_delta, notes }) {
    const client = await getClient();

    try {
      await client.query('BEGIN');

      // Get current intention
      const current = await client.query(
        'SELECT * FROM intentions WHERE id = $1',
        [intentionId]
      );

      if (current.rows.length === 0) {
        throw new Error('Intention not found');
      }

      const intention = current.rows[0];

      // Record evolution history
      if (new_content || energy_delta) {
        await client.query(
          `INSERT INTO intention_evolution (intention_id, old_content, old_energy, notes)
           VALUES ($1, $2, $3, $4)`,
          [intentionId, intention.content, intention.energy, notes]
        );
      }

      // Update intention
      const updates = [];
      const values = [];
      let paramIndex = 1;

      if (new_content) {
        updates.push(`content = $${paramIndex}`);
        values.push(new_content);
        paramIndex++;
      }

      if (energy_delta !== undefined) {
        updates.push(`energy = GREATEST(0, LEAST(1, energy + $${paramIndex}))`);
        values.push(energy_delta);
        paramIndex++;
      }

      if (updates.length > 0) {
        values.push(intentionId);
        await client.query(
          `UPDATE intentions SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
           WHERE id = $${paramIndex}`,
          values
        );
      }

      await client.query('COMMIT');

      // Return updated intention
      const updated = await client.query(
        'SELECT * FROM intentions WHERE id = $1',
        [intentionId]
      );

      return updated.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Merge multiple intentions
   */
  async mergeIntentions(intentionIds, mergedContent, mergeReason) {
    const client = await getClient();

    try {
      await client.query('BEGIN');

      // Get all intentions to merge
      const intentions = await client.query(
        'SELECT * FROM intentions WHERE id = ANY($1)',
        [intentionIds]
      );

      if (intentions.rows.length !== intentionIds.length) {
        throw new Error('Some intentions not found');
      }

      // Calculate combined energy (average)
      const totalEnergy = intentions.rows.reduce((sum, i) => sum + parseFloat(i.energy), 0);
      const averageEnergy = totalEnergy / intentions.rows.length;

      // Create merged intention
      const mergedId = `int_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      await client.query(
        `INSERT INTO intentions (id, content, energy, status, context)
         VALUES ($1, $2, $3, 'active', $4)`,
        [
          mergedId,
          mergedContent,
          averageEnergy,
          JSON.stringify({
            merge_reason: mergeReason,
            merged_from: intentionIds
          })
        ]
      );

      // Mark original intentions as abandoned with merge reference
      for (const id of intentionIds) {
        await client.query(
          `UPDATE intentions
           SET status = 'abandoned',
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [id]
        );

        await client.query(
          `INSERT INTO intention_evolution (intention_id, old_content, old_energy, notes)
           SELECT id, content, energy, $2
           FROM intentions WHERE id = $1`,
          [id, `Merged into ${mergedId}: ${mergeReason}`]
        );
      }

      await client.query('COMMIT');

      return {
        id: mergedId,
        content: mergedContent,
        energy: averageEnergy,
        status: 'active',
        context: { merge_reason: mergeReason, merged_from: intentionIds }
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Fulfill an intention
   */
  async fulfillIntention(intentionId, fulfillmentNotes) {
    const client = await getClient();

    try {
      await client.query('BEGIN');

      // Update status
      await client.query(
        `UPDATE intentions
         SET status = 'fulfilled',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [intentionId]
      );

      // Add to evolution history
      if (fulfillmentNotes) {
        const current = await client.query(
          'SELECT content, energy FROM intentions WHERE id = $1',
          [intentionId]
        );

        if (current.rows.length > 0) {
          await client.query(
            `INSERT INTO intention_evolution (intention_id, old_content, old_energy, notes)
             VALUES ($1, $2, $3, $4)`,
            [
              intentionId,
              current.rows[0].content,
              current.rows[0].energy,
              `Fulfilled: ${fulfillmentNotes}`
            ]
          );
        }
      }

      await client.query('COMMIT');

      const result = await query('SELECT * FROM intentions WHERE id = $1', [intentionId]);
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Abandon an intention
   */
  async abandonIntention(intentionId, reason) {
    const client = await getClient();

    try {
      await client.query('BEGIN');

      // Update status
      await client.query(
        `UPDATE intentions
         SET status = 'abandoned',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [intentionId]
      );

      // Add to evolution history
      const current = await client.query(
        'SELECT content, energy FROM intentions WHERE id = $1',
        [intentionId]
      );

      if (current.rows.length > 0) {
        await client.query(
          `INSERT INTO intention_evolution (intention_id, old_content, old_energy, notes)
           VALUES ($1, $2, $3, $4)`,
          [
            intentionId,
            current.rows[0].content,
            current.rows[0].energy,
            `Abandoned: ${reason}`
          ]
        );
      }

      await client.query('COMMIT');

      const result = await query('SELECT * FROM intentions WHERE id = $1', [intentionId]);
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Find related intentions
   */
  async findRelatedIntentions(intentionId, includeChildren = true) {
    const related = [];

    // Get the intention itself
    const intention = await query('SELECT * FROM intentions WHERE id = $1', [intentionId]);
    if (intention.rows.length > 0) {
      related.push(intention.rows[0]);

      // Get parent if exists
      if (intention.rows[0].parent_id) {
        const parent = await query('SELECT * FROM intentions WHERE id = $1', [intention.rows[0].parent_id]);
        if (parent.rows.length > 0) {
          related.push(parent.rows[0]);
        }
      }

      // Get children if requested
      if (includeChildren) {
        const children = await query(
          `SELECT i.* FROM intentions i
           JOIN intention_children ic ON i.id = ic.child_id
           WHERE ic.parent_id = $1`,
          [intentionId]
        );
        related.push(...children.rows);
      }
    }

    return related;
  }

  /**
   * Get statistics
   */
  async getStats() {
    const stats = await query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'active') as active,
        COUNT(*) FILTER (WHERE status = 'suspended') as suspended,
        COUNT(*) FILTER (WHERE status = 'fulfilled') as fulfilled,
        COUNT(*) FILTER (WHERE status = 'abandoned') as abandoned,
        AVG(energy) as average_energy,
        MAX(energy) as max_energy,
        MIN(energy) as min_energy
      FROM intentions
    `);

    const withJourneys = await query(`
      SELECT COUNT(DISTINCT intention_id) as count
      FROM journeys
    `);

    return {
      ...stats.rows[0],
      with_journeys: withJourneys.rows[0].count
    };
  }
}