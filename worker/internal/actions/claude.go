package actions

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
)

func debugActions() bool { return os.Getenv("DEBUG_ACTIONS") == "1" }

const (
	claudeModel    = "claude-sonnet-4-6"
	claudeEndpoint = "https://api.anthropic.com/v1/messages"
	maxTokens      = 1024
)

// SuggestedAction is a single structured action extracted from a document.
// ActionType matches the action_type enum in the DB.
// Payload is raw JSON whose shape depends on ActionType:
//
//	calendar_event: {title, date, time?, notes?, all_day}
//	task:           {title, due_date?, notes?, priority}
//	reminder:       {title, message, remind_at?, item?}
//	note:           {title, content}
type SuggestedAction struct {
	ActionType string
	Payload    json.RawMessage
}

// Analyze sends the document's OCR text to Claude Sonnet with tool calling
// enabled and collects any action suggestions Claude emits. Returns nil, nil
// when ANTHROPIC_API_KEY is not set (stub mode) or when Claude finds no
// actionable items in the document.
func Analyze(ocrText, documentType string) ([]SuggestedAction, error) {
	apiKey := os.Getenv("ANTHROPIC_API_KEY")
	if apiKey == "" {
		return nil, nil
	}

	reqBody := claudeRequest{
		Model:     claudeModel,
		MaxTokens: maxTokens,
		System:    systemPrompt,
		Tools:     actionTools,
		Messages: []claudeMessage{
			{Role: "user", Content: buildUserPrompt(ocrText, documentType)},
		},
	}

	bodyBytes, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}
	if debugActions() {
		log.Printf("[actions] DEBUG request: %s", string(bodyBytes))
	}

	req, err := http.NewRequest(http.MethodPost, claudeEndpoint, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", apiKey)
	req.Header.Set("anthropic-version", "2023-06-01")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("claude request: %w", err)
	}
	defer resp.Body.Close()

	respBytes, _ := io.ReadAll(resp.Body)
	if debugActions() {
		log.Printf("[actions] DEBUG response: %s", string(respBytes))
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("claude returned %d: %s", resp.StatusCode, string(respBytes))
	}

	var claudeResp claudeResponse
	if err := json.Unmarshal(respBytes, &claudeResp); err != nil {
		return nil, fmt.Errorf("unmarshal response: %w", err)
	}

	var actions []SuggestedAction
	for _, block := range claudeResp.Content {
		if block.Type != "tool_use" {
			continue
		}
		if debugActions() {
			log.Printf("[actions] DEBUG tool_use: %s → %s", block.Name, string(block.Input))
		}
		actions = append(actions, SuggestedAction{
			ActionType: block.Name,
			Payload:    block.Input,
		})
	}
	return actions, nil
}

func buildUserPrompt(ocrText, documentType string) string {
	docTypeLabel := documentType
	if docTypeLabel == "" {
		docTypeLabel = "unknown"
	}
	return fmt.Sprintf(
		"Document type: %s\n\nDocument text:\n%s",
		docTypeLabel, ocrText,
	)
}

// ---------------------------------------------------------------------------
// Claude API types
// ---------------------------------------------------------------------------

type claudeRequest struct {
	Model     string          `json:"model"`
	MaxTokens int             `json:"max_tokens"`
	System    string          `json:"system"`
	Tools     []claudeTool    `json:"tools"`
	Messages  []claudeMessage `json:"messages"`
}

type claudeMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type claudeTool struct {
	Name        string      `json:"name"`
	Description string      `json:"description"`
	InputSchema inputSchema `json:"input_schema"`
}

type inputSchema struct {
	Type       string              `json:"type"`
	Properties map[string]property `json:"properties"`
	Required   []string            `json:"required,omitempty"`
}

type property struct {
	Type        string   `json:"type"`
	Description string   `json:"description"`
	Enum        []string `json:"enum,omitempty"`
}

type claudeResponse struct {
	Content []claudeContentBlock `json:"content"`
}

type claudeContentBlock struct {
	Type  string          `json:"type"`
	Name  string          `json:"name,omitempty"`
	Input json.RawMessage `json:"input,omitempty"`
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const systemPrompt = `You are an assistant that analyzes school documents scanned by parents and identifies concrete actions they should take.

Use the provided tools to emit structured action suggestions. Follow these rules strictly:

1. Only suggest actions when there is a genuinely concrete step the parent needs to take — a specific date, deadline, item to bring, or task to complete.
2. Do NOT suggest actions for routine informational content (homework instructions, general newsletters with no dates, class rules, etc.).
3. Call multiple tools if multiple distinct actions are warranted from a single document.
4. Infer reasonable dates from context (e.g. "next Friday" relative to a document's apparent date), but leave date fields empty if you cannot determine them with reasonable confidence.
5. Be concise — titles should be short and scannable, like a calendar entry.`

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

var actionTools = []claudeTool{
	{
		Name:        "calendar_event",
		Description: "Suggest adding a calendar event for a specific date and time mentioned in the document (e.g. field trip, birthday party, school play, bake sale).",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]property{
				"title":   {Type: "string", Description: "Short event title, e.g. 'Tommy's birthday party'"},
				"date":    {Type: "string", Description: "Date in YYYY-MM-DD format"},
				"time":    {Type: "string", Description: "Start time in HH:MM 24h format; omit if all-day"},
				"notes":   {Type: "string", Description: "Additional details (location, what to bring, etc.)"},
				"all_day": {Type: "boolean", Description: "True when no specific time is given"},
			},
			Required: []string{"title", "date", "all_day"},
		},
	},
	{
		Name:        "task",
		Description: "Suggest a to-do item the parent needs to complete (e.g. sign a permission slip, buy a birthday present, RSVP to an event).",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]property{
				"title":    {Type: "string", Description: "Short task description, e.g. 'Sign field trip permission slip'"},
				"due_date": {Type: "string", Description: "Due date in YYYY-MM-DD format; omit if unknown"},
				"notes":    {Type: "string", Description: "Extra context the parent should know"},
				"priority": {Type: "string", Enum: []string{"high", "medium", "low"}, Description: "Task urgency"},
			},
			Required: []string{"title", "priority"},
		},
	},
	{
		Name:        "reminder",
		Description: "Suggest a time-sensitive reminder, especially for physical items the parent needs to bring or prepare (e.g. 'Bring nut-free snack Friday', '$5 cash for book fair').",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]property{
				"title":     {Type: "string", Description: "Short reminder title"},
				"message":   {Type: "string", Description: "Full reminder message with all relevant details"},
				"remind_at": {Type: "string", Description: "ISO 8601 datetime to fire the reminder; omit if no specific time"},
				"item":      {Type: "string", Description: "Physical item to bring or prepare, if applicable"},
			},
			Required: []string{"title", "message"},
		},
	},
	{
		Name:        "note",
		Description: "Capture key information that is important but has no specific deadline or action (e.g. 'Class picture day: wear school colors', 'Teacher's name: Mrs. Johnson').",
		InputSchema: inputSchema{
			Type: "object",
			Properties: map[string]property{
				"title":   {Type: "string", Description: "Short note title"},
				"content": {Type: "string", Description: "The key information to preserve"},
			},
			Required: []string{"title", "content"},
		},
	},
}
