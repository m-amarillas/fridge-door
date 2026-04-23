package embed

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
)

const (
	chunkSize    = 1000 // target characters per chunk
	chunkOverlap = 200  // overlap between adjacent chunks
	batchSize    = 32   // texts per Nomic API call
)

// ChunkText splits OCR markdown into overlapping chunks of roughly chunkSize
// characters, preferring to break at paragraph or sentence boundaries.
func ChunkText(text string) []string {
	text = strings.TrimSpace(text)
	if len(text) == 0 {
		return nil
	}
	if len(text) <= chunkSize {
		return []string{text}
	}

	var chunks []string
	start := 0
	for start < len(text) {
		end := start + chunkSize
		if end >= len(text) {
			chunks = append(chunks, strings.TrimSpace(text[start:]))
			break
		}

		// Prefer breaking at a paragraph boundary (\n\n).
		if i := strings.LastIndex(text[start:end], "\n\n"); i > chunkSize/2 {
			end = start + i + 2
		} else if i := strings.LastIndexAny(text[start:end], ".!?\n"); i > chunkSize/2 {
			// Fall back to sentence or line boundary.
			end = start + i + 1
		}
		// Otherwise break at chunkSize (mid-word acceptable for dense OCR text).

		chunks = append(chunks, strings.TrimSpace(text[start:end]))

		next := end - chunkOverlap
		if next <= start {
			next = start + 1
		}
		start = next
	}
	return chunks
}

type nomicEmbedRequest struct {
	Model    string   `json:"model"`
	Texts    []string `json:"texts"`
	TaskType string   `json:"task_type"`
}

type nomicEmbedResponse struct {
	Embeddings [][]float32 `json:"embeddings"`
}

// Embed calls the self-hosted Nomic Embed v1.5 service and returns one 768-dim
// vector per chunk. Returns zero vectors when NOMIC_EMBED_URL is unset.
func Embed(chunks []string) ([][]float32, error) {
	embedURL := os.Getenv("NOMIC_EMBED_URL")
	if embedURL == "" {
		zeros := make([][]float32, len(chunks))
		for i := range zeros {
			zeros[i] = make([]float32, 768)
		}
		return zeros, nil
	}

	all := make([][]float32, 0, len(chunks))
	for i := 0; i < len(chunks); i += batchSize {
		end := i + batchSize
		if end > len(chunks) {
			end = len(chunks)
		}

		vecs, err := embedBatch(embedURL, chunks[i:end])
		if err != nil {
			return nil, fmt.Errorf("embed batch [%d:%d]: %w", i, end, err)
		}
		all = append(all, vecs...)
	}
	return all, nil
}

func embedBatch(embedURL string, texts []string) ([][]float32, error) {
	reqBody := nomicEmbedRequest{
		Model:    "nomic-embed-text-v1.5",
		Texts:    texts,
		TaskType: "search_document",
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("marshal: %w", err)
	}

	req, err := http.NewRequest(http.MethodPost, embedURL+"/v1/embedding/text", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if apiKey := os.Getenv("NOMIC_EMBED_API_KEY"); apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("POST: %w", err)
	}
	defer resp.Body.Close()

	respBytes, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("nomic embed returned %d: %s", resp.StatusCode, string(respBytes))
	}

	var embedResp nomicEmbedResponse
	if err := json.Unmarshal(respBytes, &embedResp); err != nil {
		return nil, fmt.Errorf("unmarshal: %w", err)
	}

	if len(embedResp.Embeddings) != len(texts) {
		return nil, fmt.Errorf("expected %d embeddings, got %d", len(texts), len(embedResp.Embeddings))
	}
	return embedResp.Embeddings, nil
}
