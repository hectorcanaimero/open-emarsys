package httpx

import (
	"encoding/json"
	"net/http"
)

// Envelope is the public API response wrapper (C2).
type Envelope struct {
	ReplyCode int    `json:"replyCode"`
	ReplyText string `json:"replyText"`
	Data      any    `json:"data"`
}

// WriteEnvelope writes data wrapped in the C2 envelope. replyCode 0 means
// success (HTTP 200); any other value is a business error (HTTP 400).
func WriteEnvelope(w http.ResponseWriter, replyCode int, replyText string, data any) {
	status := http.StatusOK
	if replyCode != 0 {
		status = http.StatusBadRequest
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(Envelope{
		ReplyCode: replyCode,
		ReplyText: replyText,
		Data:      data,
	})
}
