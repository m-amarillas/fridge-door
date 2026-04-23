package processor

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"

	"github.com/hibiken/asynq"
	"github.com/the-fridge-door/worker/internal/actions"
	"github.com/the-fridge-door/worker/internal/db"
	"github.com/the-fridge-door/worker/internal/embed"
	"github.com/the-fridge-door/worker/internal/ocr"
	"github.com/the-fridge-door/worker/internal/queue"
)

type DocumentProcessor struct {
	db *db.DB
}

func New(database *db.DB) *DocumentProcessor {
	return &DocumentProcessor{db: database}
}

// ProcessDocument is the Asynq task handler for queue.TypeProcessDocument.
// Pipeline: set processing → fetch image → OCR → store text → chunk → embed → write chunks → set indexed.
func (p *DocumentProcessor) ProcessDocument(ctx context.Context, t *asynq.Task) error {
	var payload queue.Payload
	if err := json.Unmarshal(t.Payload(), &payload); err != nil {
		return fmt.Errorf("unmarshal payload: %w", err)
	}

	log.Printf("[worker] start document_id=%s user_id=%s attempt=%d",
		payload.DocumentID, payload.UserID, payload.Attempt)

	if err := p.db.SetProcessing(ctx, payload.DocumentID); err != nil {
		return fmt.Errorf("set processing: %w", err)
	}

	// 1. Fetch image from Supabase Storage.
	imageBytes, err := downloadImage(payload.ImageURL)
	if err != nil {
		_ = p.db.SetFailed(ctx, payload.DocumentID, err.Error())
		return fmt.Errorf("download image: %w", err)
	}
	log.Printf("[worker] image fetched document_id=%s bytes=%d", payload.DocumentID, len(imageBytes))

	// 2. OCR.
	b64 := base64.StdEncoding.EncodeToString(imageBytes)
	ocrText, err := ocr.Run(b64)
	if err != nil {
		_ = p.db.SetFailed(ctx, payload.DocumentID, err.Error())
		return fmt.Errorf("OCR: %w", err)
	}
	log.Printf("[worker] OCR done document_id=%s text_len=%d", payload.DocumentID, len(ocrText))

	// 3. Persist OCR text.
	if err := p.db.StoreOCRText(ctx, payload.DocumentID, ocrText); err != nil {
		_ = p.db.SetFailed(ctx, payload.DocumentID, err.Error())
		return fmt.Errorf("store OCR text: %w", err)
	}

	// 4. Chunk.
	chunks := embed.ChunkText(ocrText)
	if len(chunks) == 0 {
		log.Printf("[worker] empty OCR text document_id=%s — marking indexed", payload.DocumentID)
		return p.db.SetIndexed(ctx, payload.DocumentID)
	}

	// 5. Embed.
	embeddings, err := embed.Embed(chunks)
	if err != nil {
		_ = p.db.SetFailed(ctx, payload.DocumentID, err.Error())
		return fmt.Errorf("embed: %w", err)
	}

	// 6. Write document_chunks.
	dbChunks := make([]db.Chunk, len(chunks))
	for i, text := range chunks {
		dbChunks[i] = db.Chunk{
			DocumentID: payload.DocumentID,
			UserID:     payload.UserID,
			ChunkIndex: i,
			ChunkText:  text,
			Embedding:  embeddings[i],
		}
	}

	if err := p.db.InsertChunks(ctx, dbChunks); err != nil {
		_ = p.db.SetFailed(ctx, payload.DocumentID, err.Error())
		return fmt.Errorf("insert chunks: %w", err)
	}

	// 7. Mark indexed.
	if err := p.db.SetIndexed(ctx, payload.DocumentID); err != nil {
		return fmt.Errorf("set indexed: %w", err)
	}

	log.Printf("[worker] done document_id=%s chunks=%d", payload.DocumentID, len(chunks))

	// 8. Analyze actions — non-critical. Errors here are logged and stored on the
	// document row but never fail the Asynq job; the document stays indexed.
	p.analyzeActions(ctx, payload.DocumentID, payload.UserID, ocrText)

	return nil
}

// analyzeActions calls Claude Sonnet to extract structured action suggestions
// from the document's OCR text and persists them to document_actions.
// All errors are absorbed — action analysis must never roll back a successful index.
func (p *DocumentProcessor) analyzeActions(ctx context.Context, documentID, userID, ocrText string) {
	if err := p.db.SetActionsAnalyzing(ctx, documentID); err != nil {
		log.Printf("[worker] actions: set analyzing failed document_id=%s: %v", documentID, err)
		return
	}

	suggested, err := actions.Analyze(ocrText, "")
	if err != nil {
		log.Printf("[worker] actions: analysis failed document_id=%s: %v", documentID, err)
		_ = p.db.SetActionsFailed(ctx, documentID)
		return
	}

	if len(suggested) == 0 {
		log.Printf("[worker] actions: none found document_id=%s", documentID)
		_ = p.db.SetActionsReady(ctx, documentID)
		return
	}

	dbActions := make([]db.Action, 0, len(suggested))
	for _, a := range suggested {
		dbActions = append(dbActions, db.Action{
			DocumentID: documentID,
			UserID:     userID,
			ActionType: a.ActionType,
			Payload:    a.Payload,
		})
	}

	if err := p.db.InsertActions(ctx, dbActions); err != nil {
		log.Printf("[worker] actions: insert failed document_id=%s: %v", documentID, err)
		_ = p.db.SetActionsFailed(ctx, documentID)
		return
	}

	_ = p.db.SetActionsReady(ctx, documentID)
	log.Printf("[worker] actions done document_id=%s count=%d", documentID, len(dbActions))
}

// downloadImage fetches the image from Supabase Storage using the service role key.
func downloadImage(imageURL string) ([]byte, error) {
	req, err := http.NewRequest(http.MethodGet, imageURL, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}

	if serviceKey := os.Getenv("SUPABASE_SERVICE_ROLE_KEY"); serviceKey != "" {
		req.Header.Set("Authorization", "Bearer "+serviceKey)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("GET: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("image download returned %d: %s", resp.StatusCode, string(body))
	}
	return io.ReadAll(resp.Body)
}
