package ocr

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
)

type mistralOCRRequest struct {
	Model    string             `json:"model"`
	Document mistralDocumentObj `json:"document"`
}

type mistralDocumentObj struct {
	Type     string `json:"type"`
	ImageURL string `json:"image_url"`
}

type mistralOCRResponse struct {
	Pages []struct {
		Markdown string `json:"markdown"`
	} `json:"pages"`
}

// Run sends a base64-encoded image to the Mistral OCR API and returns the
// markdown text. Returns a stub when MISTRAL_API_KEY is not set.
func Run(base64Image string) (string, error) {
	apiKey := os.Getenv("MISTRAL_API_KEY")
	if apiKey == "" {
		return "[STUB] OCR not configured — set MISTRAL_API_KEY to enable real OCR.", nil
	}

	reqBody := mistralOCRRequest{
		Model: "mistral-ocr-latest",
		Document: mistralDocumentObj{
			Type:     "image_url",
			ImageURL: "data:image/jpeg;base64," + base64Image,
		},
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		return "", fmt.Errorf("marshal request: %w", err)
	}

	req, err := http.NewRequest(http.MethodPost, "https://api.mistral.ai/v1/ocr", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("mistral request: %w", err)
	}
	defer resp.Body.Close()

	respBytes, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("mistral OCR returned %d: %s", resp.StatusCode, string(respBytes))
	}

	var mistralResp mistralOCRResponse
	if err := json.Unmarshal(respBytes, &mistralResp); err != nil {
		return "", fmt.Errorf("unmarshal mistral response: %w", err)
	}

	var out bytes.Buffer
	for i, page := range mistralResp.Pages {
		if i > 0 {
			out.WriteString("\n\n--- page break ---\n\n")
		}
		out.WriteString(page.Markdown)
	}
	return out.String(), nil
}
