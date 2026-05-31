import { query } from '../database/connection.js';
import { embedder } from '../embeddings/embedder.js';

/**
 * Гибридный поиск - комбинирует векторный и текстовый поиск
 * Решает проблему плохих эмбеддингов для русского языка
 */
export class HybridIntentionSearcher {

    /**
     * Извлекает ключевые слова из запроса
     */
    extractKeywords(text) {
        // Удаляем стоп-слова
        const stopWords = new Set(['в', 'на', 'и', 'для', 'с', 'по', 'из', 'к', 'от', 'до', 'a', 'the', 'in', 'on', 'for', 'with']);
        const words = text.toLowerCase()
            .split(/\s+/)
            .filter(w => w.length > 2 && !stopWords.has(w));
        return words;
    }

    /**
     * Гибридный поиск с re-ranking
     */
    async searchHybrid(searchQuery, options = {}) {
        const {
            limit = 5,
            min_energy = 0.3,
            context_boost = {}
        } = options;

        // 1. Векторный поиск (может быть плохим для русского)
        let vectorResults = [];
        try {
            await embedder.initialize();
            const queryEmbedding = await embedder.embed(searchQuery);
            const vectorString = `[${queryEmbedding.join(',')}]`;

            const vectorSearch = await query(`
                SELECT
                    id,
                    content,
                    energy,
                    status,
                    context,
                    1 - (embedding <=> $1::vector) as vector_score
                FROM intentions
                WHERE status = 'active'
                    AND energy >= $2
                    AND embedding IS NOT NULL
                ORDER BY embedding <=> $1::vector
                LIMIT $3
            `, [vectorString, min_energy, limit * 3]); // берём больше для re-ranking

            vectorResults = vectorSearch.rows;
        } catch (error) {
            console.error('Vector search failed:', error);
        }

        // 2. Keyword поиск (fallback для русского)
        const keywords = this.extractKeywords(searchQuery);
        let keywordResults = [];

        if (keywords.length > 0) {
            // Создаём ILIKE условия для каждого keyword
            const ilikeConditions = keywords.map((_, i) =>
                `(content ILIKE $${i + 3} OR context::text ILIKE $${i + 3})`
            ).join(' OR ');

            const keywordSearch = await query(`
                SELECT DISTINCT
                    id,
                    content,
                    energy,
                    status,
                    context,
                    -- Считаем сколько keywords совпало
                    (${keywords.map((_, i) =>
                        `CASE WHEN content ILIKE $${i + 3} THEN 1 ELSE 0 END`
                    ).join(' + ')}) as keyword_matches
                FROM intentions
                WHERE status = 'active'
                    AND energy >= $1
                    AND (${ilikeConditions})
                ORDER BY keyword_matches DESC, energy DESC
                LIMIT $2
            `, [
                min_energy,
                limit * 2,
                ...keywords.map(k => `%${k}%`)
            ]);

            keywordResults = keywordSearch.rows;
        }

        // 3. Объединяем и re-rank результаты
        const allResults = new Map();

        // Добавляем векторные результаты
        vectorResults.forEach(row => {
            allResults.set(row.id, {
                ...row,
                vector_score: row.vector_score || 0,
                keyword_score: 0,
                hybrid_score: row.vector_score || 0
            });
        });

        // Добавляем/обновляем keyword результаты
        keywordResults.forEach(row => {
            if (allResults.has(row.id)) {
                const existing = allResults.get(row.id);
                existing.keyword_score = (row.keyword_matches || 0) / Math.max(keywords.length, 1);
                // Гибридный скор: если keywords совпали, даём больше веса
                // Для русского языка keywords важнее!
                existing.hybrid_score = existing.vector_score * 0.2 + existing.keyword_score * 0.8;
            } else {
                // Если найдено только через keywords - даём высокий скор
                const keyScore = (row.keyword_matches || 0) / Math.max(keywords.length, 1);
                allResults.set(row.id, {
                    ...row,
                    vector_score: 0,
                    keyword_score: keyScore,
                    hybrid_score: keyScore * 1.2  // Boost для keyword-only matches
                });
            }
        });

        // 4. Context boost
        if (context_boost && Object.keys(context_boost).length > 0) {
            allResults.forEach(result => {
                const ctx = typeof result.context === 'string' ?
                    JSON.parse(result.context) : result.context;

                // Если контекст совпадает, увеличиваем скор
                for (const [key, value] of Object.entries(context_boost)) {
                    if (ctx && ctx[key] === value) {
                        result.hybrid_score += 0.2;
                    }
                }
            });
        }

        // 5. Сортируем по гибридному скору и возвращаем топ N
        const sortedResults = Array.from(allResults.values())
            .sort((a, b) => b.hybrid_score - a.hybrid_score)
            .slice(0, limit);

        // Форматируем результаты
        return sortedResults.map(row => ({
            ...row,
            context: typeof row.context === 'string' ? JSON.parse(row.context) : row.context,
            relevance: {
                vector_score: row.vector_score,
                keyword_score: row.keyword_score,
                hybrid_score: row.hybrid_score
            }
        }));
    }

    /**
     * Специальный поиск для русского языка
     */
    async searchRussian(searchQuery, options = {}) {
        // Для русского языка даём больше веса keyword matching
        return this.searchHybrid(searchQuery, {
            ...options,
            keyword_weight: 0.8,  // 80% keywords, 20% vectors
            vector_weight: 0.2
        });
    }

    /**
     * Прямой поиск по точному совпадению
     */
    async searchExact(searchTerms, options = {}) {
        const {
            limit = 5,
            min_energy = 0.3
        } = options;

        const terms = Array.isArray(searchTerms) ? searchTerms : [searchTerms];
        const conditions = terms.map((_, i) => `content ILIKE $${i + 3}`).join(' AND ');

        const result = await query(`
            SELECT
                id,
                content,
                energy,
                status,
                context
            FROM intentions
            WHERE status = 'active'
                AND energy >= $1
                AND (${conditions})
            ORDER BY energy DESC
            LIMIT $2
        `, [
            min_energy,
            limit,
            ...terms.map(t => `%${t}%`)
        ]);

        return result.rows.map(row => ({
            ...row,
            context: typeof row.context === 'string' ? JSON.parse(row.context) : row.context
        }));
    }
}

export const hybridSearcher = new HybridIntentionSearcher();