import { query } from '../database/connection.js';
import { embedder } from '../embeddings/embedder.js';

/**
 * Semantic intention searcher — context-aware search over intentions.
 */
export class IntentionSearcher {
    /**
     * Semantic search over intentions for a given query.
     */
    async searchByContext(searchQuery, options = {}) {
        const {
            limit = 5,
            min_energy = 0.3,
            include_journey = true,
            context_boost = {} // e.g. { project: 'my-project', type: 'development' }
        } = options;

        // Generate the query embedding
        await embedder.initialize();
        const queryEmbedding = await embedder.embed(searchQuery);
        const vectorString = `[${queryEmbedding.join(',')}]`;

        // Semantic search weighted by energy and context
        const searchSql = `
            WITH semantic_matches AS (
                SELECT
                    i.id,
                    i.content,
                    i.energy,
                    i.status,
                    i.context,
                    i.parent_id,
                    i.created_at,
                    i.updated_at,
                    1 - (i.embedding <=> $1::vector) as similarity,
                    -- Bonus for matching context
                    CASE
                        WHEN $2::jsonb @> i.context THEN 0.2
                        WHEN i.context @> $2::jsonb THEN 0.1
                        ELSE 0
                    END as context_bonus
                FROM intentions i
                WHERE i.status = 'active'
                    AND i.energy >= $3
                    AND i.embedding IS NOT NULL
                ORDER BY i.embedding <=> $1::vector
                LIMIT $4 * 2  -- take some headroom
            ),
            scored_matches AS (
                SELECT
                    *,
                    -- Combined score: semantics + context + energy
                    (similarity + context_bonus) * energy as final_score
                FROM semantic_matches
            )
            SELECT
                sm.*,
                -- Latest progress
                (SELECT json_build_object(
                    'last_action', p.action,
                    'last_outcome', p.outcome,
                    'timestamp', p.timestamp
                )
                FROM progress_log p
                WHERE p.intention_id = sm.id
                ORDER BY p.timestamp DESC
                LIMIT 1) as last_progress,
                -- Current milestone
                (SELECT json_build_object(
                    'milestone_id', m.id,
                    'milestone_title', m.title,
                    'milestone_status', m.status
                )
                FROM journeys j
                JOIN milestones m ON m.id = j.current_milestone_id
                WHERE j.intention_id = sm.id) as current_milestone
            FROM scored_matches sm
            ORDER BY final_score DESC
            LIMIT $4
        `;

        const result = await query(searchSql, [
            vectorString,
            JSON.stringify(context_boost),
            min_energy,
            limit
        ]);

        // Parse JSON fields
        return result.rows.map(row => ({
            ...row,
            context: typeof row.context === 'string' ? JSON.parse(row.context) : row.context,
            relevance: {
                semantic_similarity: row.similarity,
                context_bonus: row.context_bonus,
                final_score: row.final_score
            }
        }));
    }

    /**
     * Search intentions by project.
     */
    async searchByProject(project, limit = 5) {
        return await this.searchByContext(project, {
            limit,
            context_boost: { project }
        });
    }

    /**
     * Search intentions by type.
     */
    async searchByType(type, limit = 5) {
        return await this.searchByContext(type, {
            limit,
            context_boost: { type }
        });
    }

    /**
     * Get the top intentions by energy.
     */
    async getHighEnergyIntentions(limit = 5) {
        const result = await query(`
            SELECT
                i.*,
                (SELECT json_build_object(
                    'milestone_title',
                    (SELECT title FROM milestones m
                     WHERE m.id = j.current_milestone_id),
                    'progress_count',
                    (SELECT COUNT(*) FROM progress_log p
                     WHERE p.intention_id = i.id
                     AND p.timestamp > NOW() - INTERVAL '7 days')
                ) FROM journeys j WHERE j.intention_id = i.id) as journey_info
            FROM intentions i
            WHERE i.status = 'active'
            ORDER BY i.energy DESC
            LIMIT $1
        `, [limit]);

        return result.rows.map(row => ({
            ...row,
            context: typeof row.context === 'string' ? JSON.parse(row.context) : row.context
        }));
    }

    /**
     * Find similar intentions (candidates for merging).
     */
    async findSimilarIntentions(intentionId, threshold = 0.8) {
        const result = await query(`
            SELECT
                i1.id as source_id,
                i2.id as similar_id,
                i2.content,
                i2.energy,
                1 - (i1.embedding <=> i2.embedding) as similarity
            FROM intentions i1
            CROSS JOIN intentions i2
            WHERE i1.id = $1
                AND i2.id != $1
                AND i1.embedding IS NOT NULL
                AND i2.embedding IS NOT NULL
                AND i1.status = 'active'
                AND i2.status = 'active'
                AND 1 - (i1.embedding <=> i2.embedding) > $2
            ORDER BY similarity DESC
        `, [intentionId, threshold]);

        return result.rows;
    }

    /**
     * Context-aware search over recent conversation history.
     */
    async searchByConversationContext(messages, limit = 3) {
        // Use the most recent messages as the search context
        const recentText = messages
            .slice(-5) // last 5 messages
            .map(m => m.content)
            .join(' ');

        return await this.searchByContext(recentText, { limit });
    }
}

// Singleton instance
export const intentionSearcher = new IntentionSearcher();
