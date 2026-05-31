import { pipeline } from '@xenova/transformers';
import { query } from '../database/connection.js';

/**
 * Intention Embedder - генерирует векторные представления намерений
 * Использует all-MiniLM-L6-v2 - компактную модель с 384 dimensions
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
     * Генерирует эмбеддинг для текста
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
     * Создаёт поисковый текст из намерения
     */
    buildSearchText(intention) {
        const parts = [intention.content];

        // Добавляем важные поля из контекста
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
     * Генерирует и сохраняет эмбеддинг для намерения
     */
    async embedIntention(intention) {
        const searchText = this.buildSearchText(intention);
        const embedding = await this.embed(searchText);

        // Сохраняем в БД
        await query(
            'UPDATE intentions SET embedding = $1 WHERE id = $2',
            [`[${embedding.join(',')}]`, intention.id]
        );

        return embedding;
    }

    /**
     * Генерирует эмбеддинги для всех намерений без них
     */
    async embedAllMissing() {
        const missingEmbeddings = await query(
            'SELECT id, content, context FROM intentions WHERE embedding IS NULL'
        );

        console.error(`Found ${missingEmbeddings.rows.length} intentions without embeddings`);

        let processed = 0;
        for (const intention of missingEmbeddings.rows) {
            try {
                // Парсим context если он строка
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

// Singleton экземпляр
export const embedder = new IntentionEmbedder();