-- Full-text vector similarity search across document_chunks.
-- Accepts the query embedding as float[] so PostgREST can pass it as a JSON
-- array without needing a native vector cast on the client side.
-- The inner CTE uses ORDER BY <=> LIMIT to hit the HNSW index, then we
-- deduplicate to one best-scoring chunk per document before returning.
CREATE OR REPLACE FUNCTION search_documents(
    query_embedding float[],
    p_user_id       uuid,
    match_count     int DEFAULT 10
)
RETURNS TABLE (document_id uuid, score double precision)
LANGUAGE sql STABLE
AS $$
    WITH top_chunks AS (
        SELECT
            dc.document_id,
            dc.embedding <=> query_embedding::vector AS score
        FROM document_chunks dc
        WHERE dc.user_id = p_user_id
        ORDER BY dc.embedding <=> query_embedding::vector ASC
        LIMIT GREATEST(match_count * 10, 50)
    ),
    best_per_doc AS (
        SELECT document_id, MIN(score) AS score
        FROM top_chunks
        GROUP BY document_id
    )
    SELECT document_id, score
    FROM best_per_doc
    ORDER BY score ASC
    LIMIT match_count;
$$;
