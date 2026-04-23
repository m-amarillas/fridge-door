package main

import (
	"log"
	"net/http"
	"os"

	"github.com/hibiken/asynq"
	"github.com/joho/godotenv"
	"github.com/the-fridge-door/worker/internal/db"
	"github.com/the-fridge-door/worker/internal/processor"
	"github.com/the-fridge-door/worker/internal/queue"
)

func main() {
	if err := godotenv.Load(); err != nil {
		log.Println("no .env file found, using environment variables")
	}

	redisURL := os.Getenv("REDIS_URL")
	if redisURL == "" {
		redisURL = "redis://localhost:6379"
	}

	redisOpt, err := asynq.ParseRedisURI(redisURL)
	if err != nil {
		log.Fatalf("invalid REDIS_URL: %v", err)
	}

	database, err := db.New()
	if err != nil {
		log.Fatalf("failed to connect to database: %v", err)
	}
	defer database.Close()

	asynqClient := asynq.NewClient(redisOpt)
	defer asynqClient.Close()

	proc := processor.New(database)

	go runHTTPServer(asynqClient)

	srv := asynq.NewServer(redisOpt, asynq.Config{
		Concurrency: 5,
		Queues:      map[string]int{"default": 1},
	})

	mux := asynq.NewServeMux()
	mux.HandleFunc(queue.TypeProcessDocument, proc.ProcessDocument)

	log.Println("starting Asynq worker...")
	if err := srv.Run(mux); err != nil {
		log.Fatalf("worker failed: %v", err)
	}
}

func runHTTPServer(client *asynq.Client) {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("/enqueue", queue.EnqueueHandler(client))

	log.Printf("HTTP server listening on :%s", port)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Printf("HTTP server error: %v", err)
	}
}
