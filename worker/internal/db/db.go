package db

import (
	"context"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	pgvector "github.com/pgvector/pgvector-go"
	pgxvector "github.com/pgvector/pgvector-go/pgx"
)

type DB struct {
	pool *pgxpool.Pool
}

func New() (*DB, error) {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		return nil, fmt.Errorf("DATABASE_URL not set")
	}

	config, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
	}

	config.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
		return pgxvector.RegisterTypes(ctx, conn)
	}

	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		return nil, fmt.Errorf("connect to database: %w", err)
	}

	return &DB{pool: pool}, nil
}

func (db *DB) Close() {
	db.pool.Close()
}

// SetProcessing transitions the document to 'processing' and increments the attempt counter.
func (db *DB) SetProcessing(ctx context.Context, documentID string) error {
	_, err := db.pool.Exec(ctx,
		`UPDATE documents SET status = 'processing', attempt = attempt + 1 WHERE id = $1`,
		documentID,
	)
	return err
}

// StoreOCRText writes the OCR markdown output to the document row.
func (db *DB) StoreOCRText(ctx context.Context, documentID, ocrText string) error {
	_, err := db.pool.Exec(ctx,
		`UPDATE documents SET ocr_text = $1 WHERE id = $2`,
		ocrText, documentID,
	)
	return err
}

// SetDocumentType writes the auto-classified document type.
func (db *DB) SetDocumentType(ctx context.Context, documentID, documentType string) error {
	_, err := db.pool.Exec(ctx,
		`UPDATE documents SET document_type = $1 WHERE id = $2`,
		documentType, documentID,
	)
	return err
}

// SetIndexed marks the document as fully indexed.
func (db *DB) SetIndexed(ctx context.Context, documentID string) error {
	_, err := db.pool.Exec(ctx,
		`UPDATE documents SET status = 'indexed' WHERE id = $1`,
		documentID,
	)
	return err
}

// SetFailed marks the document as failed. Called when Asynq exhausts all retries.
func (db *DB) SetFailed(ctx context.Context, documentID, errMsg string) error {
	_, err := db.pool.Exec(ctx,
		`UPDATE documents SET status = 'failed', metadata = metadata || jsonb_build_object('error', $1) WHERE id = $2`,
		errMsg, documentID,
	)
	return err
}

// SetActionsAnalyzing marks the document as having action analysis in progress.
func (db *DB) SetActionsAnalyzing(ctx context.Context, documentID string) error {
	_, err := db.pool.Exec(ctx,
		`UPDATE documents SET actions_status = 'analyzing' WHERE id = $1`,
		documentID,
	)
	return err
}

// SetActionsReady marks action analysis as complete (zero or more actions stored).
func (db *DB) SetActionsReady(ctx context.Context, documentID string) error {
	_, err := db.pool.Exec(ctx,
		`UPDATE documents SET actions_status = 'ready' WHERE id = $1`,
		documentID,
	)
	return err
}

// SetActionsFailed marks action analysis as failed without affecting document status.
func (db *DB) SetActionsFailed(ctx context.Context, documentID string) error {
	_, err := db.pool.Exec(ctx,
		`UPDATE documents SET actions_status = 'failed' WHERE id = $1`,
		documentID,
	)
	return err
}

// Action is a single suggested action ready to be written to document_actions.
// Payload is pre-encoded JSON whose shape depends on ActionType.
type Action struct {
	DocumentID string
	UserID     string
	ActionType string
	Payload    []byte
}

// InsertActions writes all suggested actions for a document in a single batch.
func (db *DB) InsertActions(ctx context.Context, actions []Action) error {
	if len(actions) == 0 {
		return nil
	}
	batch := &pgx.Batch{}
	for _, a := range actions {
		batch.Queue(
			`INSERT INTO document_actions (document_id, user_id, action_type, payload)
			 VALUES ($1, $2, $3, $4)`,
			a.DocumentID, a.UserID, a.ActionType, a.Payload,
		)
	}

	br := db.pool.SendBatch(ctx, batch)
	defer br.Close()

	for i := range actions {
		if _, err := br.Exec(); err != nil {
			return fmt.Errorf("insert action %d: %w", i, err)
		}
	}
	return nil
}

// Chunk is a single text chunk with its embedding, ready to be written to document_chunks.
type Chunk struct {
	DocumentID string
	UserID     string
	ChunkIndex int
	ChunkText  string
	Embedding  []float32
}

// InsertChunks writes all chunks for a document in a single batch.
func (db *DB) InsertChunks(ctx context.Context, chunks []Chunk) error {
	batch := &pgx.Batch{}
	for _, c := range chunks {
		batch.Queue(
			`INSERT INTO document_chunks (document_id, user_id, chunk_index, chunk_text, embedding)
			 VALUES ($1, $2, $3, $4, $5)
			 ON CONFLICT (document_id, chunk_index) DO NOTHING`,
			c.DocumentID, c.UserID, c.ChunkIndex, c.ChunkText, pgvector.NewVector(c.Embedding),
		)
	}

	br := db.pool.SendBatch(ctx, batch)
	defer br.Close()

	for i := range chunks {
		if _, err := br.Exec(); err != nil {
			return fmt.Errorf("insert chunk %d: %w", i, err)
		}
	}
	return nil
}
