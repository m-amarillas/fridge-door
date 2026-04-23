package queue

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"

	"github.com/hibiken/asynq"
)

const TypeProcessDocument = "document:process"

// Payload matches the job contract in infra/contracts/jobs.md.
type Payload struct {
	DocumentID string `json:"document_id"`
	UserID     string `json:"user_id"`
	ImageURL   string `json:"image_url"`
	ImageHash  string `json:"image_hash"`
	Attempt    int    `json:"attempt"`
}

type enqueueResponse struct {
	TaskID string `json:"task_id"`
}

type enqueueError struct {
	Error string `json:"error"`
}

// EnqueueHandler returns an HTTP handler that accepts a Payload JSON body,
// creates an Asynq task, and enqueues it to the default queue.
func EnqueueHandler(client *asynq.Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		body, err := io.ReadAll(r.Body)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, enqueueError{Error: "failed to read body"})
			return
		}

		var p Payload
		if err := json.Unmarshal(body, &p); err != nil {
			writeJSON(w, http.StatusBadRequest, enqueueError{Error: "invalid JSON: " + err.Error()})
			return
		}

		if p.DocumentID == "" || p.UserID == "" || p.ImageURL == "" {
			writeJSON(w, http.StatusBadRequest, enqueueError{Error: "document_id, user_id, and image_url are required"})
			return
		}

		task := asynq.NewTask(TypeProcessDocument, body)
		info, err := client.Enqueue(task, asynq.MaxRetry(3), asynq.Queue("default"))
		if err != nil {
			log.Printf("[enqueue] failed document_id=%s: %v", p.DocumentID, err)
			writeJSON(w, http.StatusInternalServerError, enqueueError{Error: fmt.Sprintf("enqueue failed: %v", err)})
			return
		}

		log.Printf("[enqueue] queued task_id=%s document_id=%s", info.ID, p.DocumentID)
		writeJSON(w, http.StatusOK, enqueueResponse{TaskID: info.ID})
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
