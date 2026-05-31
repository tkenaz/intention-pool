import { query, getClient } from '../database/connection.js';
import {
  createMilestone,
  createProgressEntry,
  createArtifact,
  createBlocker,
  createInsight,
  createNextStep,
  JourneyTypes
} from '../types/journey.js';

export class JourneyManager {
  /**
   * Start a journey for an intention
   */
  async startJourney(intentionId, firstMilestone) {
    const client = await getClient();

    try {
      await client.query('BEGIN');

      // Check if journey already exists
      const existing = await client.query(
        'SELECT intention_id FROM journeys WHERE intention_id = $1',
        [intentionId]
      );

      if (existing.rows.length > 0) {
        throw new Error('Journey already exists for this intention');
      }

      // Create first milestone
      const milestone = createMilestone(firstMilestone);
      milestone.status = JourneyTypes.MILESTONE_STATUS.IN_PROGRESS;

      await client.query(
        `INSERT INTO milestones (id, intention_id, title, description, status, context)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          milestone.id,
          intentionId,
          milestone.title,
          milestone.description,
          milestone.status,
          JSON.stringify(milestone.context || {})
        ]
      );

      // Create journey
      await client.query(
        `INSERT INTO journeys (intention_id, current_milestone_id, metadata)
         VALUES ($1, $2, $3)`,
        [intentionId, milestone.id, JSON.stringify({})]
      );

      await client.query('COMMIT');

      return {
        intention_id: intentionId,
        current_milestone: milestone,
        message: 'Journey started'
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Add a milestone to the journey
   */
  async addMilestone(intentionId, milestoneData, fromMilestoneId = null) {
    const milestone = createMilestone(milestoneData);

    const client = await getClient();

    try {
      await client.query('BEGIN');

      // Add milestone
      await client.query(
        `INSERT INTO milestones (id, intention_id, title, description, status, context)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          milestone.id,
          intentionId,
          milestone.title,
          milestone.description,
          milestone.status,
          JSON.stringify(milestone.context || {})
        ]
      );

      // Create connection if from milestone specified
      if (fromMilestoneId) {
        await client.query(
          `INSERT INTO milestone_connections (from_milestone_id, to_milestone_id)
           VALUES ($1, $2)`,
          [fromMilestoneId, milestone.id]
        );
      }

      await client.query('COMMIT');

      return milestone;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Record progress on the journey
   */
  async recordProgress(intentionId, action, outcome = null, options = {}) {
    const entry = createProgressEntry({
      action,
      outcome,
      energy_shift: options.energy_shift,
      learned: options.learned,
      session_id: options.session_id,
      milestone_id: options.milestone_id
    });

    const client = await getClient();

    try {
      await client.query('BEGIN');

      // Add progress entry
      await client.query(
        `INSERT INTO progress_log (id, intention_id, milestone_id, action, outcome, energy_shift, learned, session_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          entry.id,
          intentionId,
          entry.milestone_id,
          entry.action,
          entry.outcome,
          entry.energy_shift,
          entry.learned,
          entry.session_id
        ]
      );

      // Update journey last_update_at
      await client.query(
        'UPDATE journeys SET last_update_at = CURRENT_TIMESTAMP WHERE intention_id = $1',
        [intentionId]
      );

      // Update intention energy if shift specified
      if (entry.energy_shift) {
        await client.query(
          'UPDATE intentions SET energy = GREATEST(0, LEAST(1, energy + $1)) WHERE id = $2',
          [entry.energy_shift, intentionId]
        );
      }

      await client.query('COMMIT');

      return entry;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Reach a milestone
   */
  async reachMilestone(intentionId, milestoneId, reflections = null) {
    const client = await getClient();

    try {
      await client.query('BEGIN');

      // Update milestone status
      await client.query(
        `UPDATE milestones
         SET status = $1, reached_at = CURRENT_TIMESTAMP, reflections = $2
         WHERE id = $3 AND intention_id = $4`,
        [JourneyTypes.MILESTONE_STATUS.REACHED, reflections, milestoneId, intentionId]
      );

      // Find next milestones
      const nextMilestones = await client.query(
        `SELECT to_milestone_id FROM milestone_connections WHERE from_milestone_id = $1`,
        [milestoneId]
      );

      let nextMilestoneId = null;
      if (nextMilestones.rows.length > 0) {
        // Set first next milestone as in progress
        nextMilestoneId = nextMilestones.rows[0].to_milestone_id;
        await client.query(
          'UPDATE milestones SET status = $1 WHERE id = $2',
          [JourneyTypes.MILESTONE_STATUS.IN_PROGRESS, nextMilestoneId]
        );
      }

      // Update journey current milestone
      await client.query(
        'UPDATE journeys SET current_milestone_id = $1, last_update_at = CURRENT_TIMESTAMP WHERE intention_id = $2',
        [nextMilestoneId, intentionId]
      );

      // Record progress
      await client.query(
        `INSERT INTO progress_log (id, intention_id, milestone_id, action, outcome)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          `progress_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          intentionId,
          milestoneId,
          `Reached milestone: ${milestoneId}`,
          reflections
        ]
      );

      await client.query('COMMIT');

      return {
        milestone_id: milestoneId,
        reached: true,
        reflections,
        next_milestone_id: nextMilestoneId
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Add a next step
   */
  async addNextStep(intentionId, stepData) {
    const step = createNextStep(stepData);

    await query(
      `INSERT INTO next_steps (id, intention_id, milestone_id, description, priority, planned_for)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        step.id,
        intentionId,
        step.milestone_id,
        step.description,
        step.priority,
        step.planned_for
      ]
    );

    // Add dependencies
    if (step.dependencies && step.dependencies.length > 0) {
      for (const depId of step.dependencies) {
        await query(
          'INSERT INTO step_dependencies (step_id, depends_on_step_id) VALUES ($1, $2)',
          [step.id, depId]
        );
      }
    }

    return step;
  }

  /**
   * Add an artifact
   */
  async addArtifact(intentionId, artifactData) {
    const artifact = createArtifact(artifactData);

    await query(
      `INSERT INTO artifacts (id, intention_id, type, title, description, location, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        artifact.id,
        intentionId,
        artifact.type,
        artifact.title,
        artifact.description,
        artifact.location,
        JSON.stringify(artifact.metadata || {})
      ]
    );

    return artifact;
  }

  /**
   * Add an insight
   */
  async addInsight(intentionId, insightData) {
    const insight = createInsight(insightData);

    const client = await getClient();

    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO insights (id, intention_id, content, trigger, significance)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          insight.id,
          intentionId,
          insight.content,
          insight.trigger,
          insight.significance
        ]
      );

      // Link to milestones
      if (insight.related_milestone_ids && insight.related_milestone_ids.length > 0) {
        for (const milestoneId of insight.related_milestone_ids) {
          await client.query(
            'INSERT INTO insight_milestones (insight_id, milestone_id) VALUES ($1, $2)',
            [insight.id, milestoneId]
          );
        }
      }

      await client.query('COMMIT');

      return insight;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Add a blocker
   */
  async addBlocker(intentionId, blockerData) {
    const blocker = createBlocker(blockerData);

    const client = await getClient();

    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO blockers (id, intention_id, description, severity)
         VALUES ($1, $2, $3, $4)`,
        [
          blocker.id,
          intentionId,
          blocker.description,
          blocker.severity
        ]
      );

      // Link to affected milestones
      if (blocker.affected_milestone_ids && blocker.affected_milestone_ids.length > 0) {
        for (const milestoneId of blocker.affected_milestone_ids) {
          await client.query(
            'INSERT INTO blocker_milestones (blocker_id, milestone_id) VALUES ($1, $2)',
            [blocker.id, milestoneId]
          );

          // Mark milestone as blocked
          await client.query(
            'UPDATE milestones SET status = $1 WHERE id = $2',
            [JourneyTypes.MILESTONE_STATUS.BLOCKED, milestoneId]
          );
        }
      }

      await client.query('COMMIT');

      return blocker;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Resolve a blocker
   */
  async resolveBlocker(blockerId, resolution) {
    const client = await getClient();

    try {
      await client.query('BEGIN');

      // Update blocker
      await client.query(
        'UPDATE blockers SET resolved_at = CURRENT_TIMESTAMP, resolution = $1 WHERE id = $2',
        [resolution, blockerId]
      );

      // Get affected milestones
      const affected = await client.query(
        'SELECT milestone_id FROM blocker_milestones WHERE blocker_id = $1',
        [blockerId]
      );

      // Unblock milestones (set back to planned unless they have other blockers)
      for (const row of affected.rows) {
        const otherBlockers = await client.query(
          `SELECT COUNT(*) FROM blocker_milestones bm
           JOIN blockers b ON b.id = bm.blocker_id
           WHERE bm.milestone_id = $1 AND b.resolved_at IS NULL AND b.id != $2`,
          [row.milestone_id, blockerId]
        );

        if (otherBlockers.rows[0].count === '0') {
          await client.query(
            'UPDATE milestones SET status = $1 WHERE id = $2',
            [JourneyTypes.MILESTONE_STATUS.PLANNED, row.milestone_id]
          );
        }
      }

      await client.query('COMMIT');

      return { blocker_id: blockerId, resolved: true, resolution };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get complete journey for an intention
   */
  async getJourney(intentionId) {
    const journey = await query(
      'SELECT * FROM journeys WHERE intention_id = $1',
      [intentionId]
    );

    if (journey.rows.length === 0) {
      return null;
    }

    const [milestones, progress, nextSteps, artifacts, insights, blockers] = await Promise.all([
      query('SELECT * FROM milestones WHERE intention_id = $1 ORDER BY created_at', [intentionId]),
      query('SELECT * FROM progress_log WHERE intention_id = $1 ORDER BY timestamp DESC', [intentionId]),
      query('SELECT * FROM next_steps WHERE intention_id = $1 AND completed = false ORDER BY priority DESC', [intentionId]),
      query('SELECT * FROM artifacts WHERE intention_id = $1 ORDER BY created_at DESC', [intentionId]),
      query('SELECT * FROM insights WHERE intention_id = $1 ORDER BY significance DESC', [intentionId]),
      query('SELECT * FROM blockers WHERE intention_id = $1 AND resolved_at IS NULL', [intentionId])
    ]);

    // Get milestone connections
    const connections = await query(
      `SELECT * FROM milestone_connections WHERE from_milestone_id IN
       (SELECT id FROM milestones WHERE intention_id = $1)`,
      [intentionId]
    );

    return {
      ...journey.rows[0],
      milestones: milestones.rows,
      progress_log: progress.rows,
      next_steps: nextSteps.rows,
      artifacts: artifacts.rows,
      insights: insights.rows,
      blockers: blockers.rows,
      milestone_connections: connections.rows
    };
  }

  /**
   * Get journey statistics
   */
  async getJourneyStats(intentionId) {
    const stats = await query(
      `SELECT
        (SELECT COUNT(*) FROM milestones WHERE intention_id = $1) as total_milestones,
        (SELECT COUNT(*) FROM milestones WHERE intention_id = $1 AND status = 'reached') as reached_milestones,
        (SELECT COUNT(*) FROM progress_log WHERE intention_id = $1) as total_actions,
        (SELECT COUNT(*) FROM artifacts WHERE intention_id = $1) as total_artifacts,
        (SELECT COUNT(*) FROM insights WHERE intention_id = $1) as total_insights,
        (SELECT COUNT(*) FROM blockers WHERE intention_id = $1 AND resolved_at IS NULL) as active_blockers,
        (SELECT COUNT(*) FROM next_steps WHERE intention_id = $1 AND completed = false) as pending_steps`,
      [intentionId]
    );

    return stats.rows[0];
  }
}