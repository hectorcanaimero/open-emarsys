package httpx

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
)

func TestWriteEnvelopeSuccess(t *testing.T) {
	w := httptest.NewRecorder()
	WriteEnvelope(w, 0, "OK", map[string]string{"id": "42"})

	if w.Code != 200 {
		t.Fatalf("status: got %d, want 200", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("content-type: got %q, want %q", ct, "application/json")
	}

	var body Envelope
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if body.ReplyCode != 0 || body.ReplyText != "OK" {
		t.Fatalf("body: got %+v", body)
	}
	data, ok := body.Data.(map[string]any)
	if !ok || data["id"] != "42" {
		t.Fatalf("body.data: got %+v", body.Data)
	}
}

func TestWriteEnvelopeBusinessError(t *testing.T) {
	w := httptest.NewRecorder()
	WriteEnvelope(w, 1001, "Invalid key field id", nil)

	if w.Code != 400 {
		t.Fatalf("status: got %d, want 400", w.Code)
	}

	var body Envelope
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if body.ReplyCode != 1001 || body.ReplyText != "Invalid key field id" || body.Data != nil {
		t.Fatalf("body: got %+v", body)
	}
}
