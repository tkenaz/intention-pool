import { pipeline } from '@xenova/transformers';
import { query } from '../database/connection.js';

/**
 * Intention embedder — produces vector representations of intentions.
 * Uses all-MiniLM-L6-v2, a compact 384-dimension model.
 */
export class IntentionEmbedder {
    constructor() {
        this.model = null;
        this.modelLoading = null;
    }

    async initialize() {
        if (this.model) return this.model;

        if (this.modelLoading) {
            return await this.modelLoading;
        }

        console.error('Initializing embedding model...');
        this.modelLoading = pipeline(
            'feature-extraction',
            'Xenova/all-MiniLM-L6-v2'
        );

        try {
            this.model = await this.modelLoading;
            console.error('Embedding model loaded successfully');
            return this.model;
        } catch (error) {
            console.error('Failed to load embedding model:', error);
            throw error;
        } finally {
            this.modelLoading = null;
        }
    }

    /**
     * Generate an embedding for a text string.
     */
    async embed(text) {
        await this.initialize();

        const output = await this.model(text, {
            pooling: 'mean',
            normalize: true
        });

        return Array.from(output.data);
    }

    /**
     * Build the search text for an intention.
     */
    buildSearchText(intention) {
        const parts = [intention.content];

        // Add important fields from the context
        if (intention.context) {
            if (intention.context.project) {
                parts.push(`project: ${intention.context.project}`);
            }
            if (intention.context.type) {
                parts.push(`type: ${intention.context.type}`);
            }
            if (intention.context.tags) {
                parts.push(intention.context.tags.join(' '));
            }
            if (intention.context.with) {
                parts.push(`with: ${intention.context.with}`);
            }
        }

        return parts.join(' ');
    }

    /**
     * Generate and persist the embedding for an intention.
     */
    async embedIntention(intention) {
        const searchText = this.buildSearchText(intention);
        const embedding = await this.embed(searchText);

        // Persist to the database
        await query(
            'UPDATE intentions SET embedding = $1 WHERE id = $2',
            [`[${embedding.join(',')}]`, intention.id]
        );

        return embedding;
    }

    /**
     * Generate embeddings for all intentions that are missing one.
     */
    async embedAllMissing() {
        const missingEmbeddings = await query(
            'SELECT id, content, context FROM intentions WHERE embedding IS NULL'
        );

        console.error(`Found ${missingEmbeddings.rows.length} intentions without embeddings`);

        let processed = 0;
        for (const intention of missingEmbeddings.rows) {
            try {
                // Parse context if it is a string
                if (typeof intention.context === 'string') {
                    intention.context = JSON.parse(intention.context);
                }

                await this.embedIntention(intention);
                processed++;

                if (processed % 10 === 0) {
                    console.error(`Processed ${processed}/${missingEmbeddings.rows.length}`);
                }
            } catch (error) {
                console.error(`Failed to embed intention ${intention.id}:`, error);
            }
        }

        console.error(`Embedded ${processed} intentions`);
        return processed;
    }
}

// Singleton instance
export const embedder = new IntentionEmbedder();
