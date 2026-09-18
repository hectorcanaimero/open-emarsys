package httpx

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
)

func TestWriteProblem(t *testing.T) {
	w := httptest.NewRecorder()
	WriteProblem(w, 404, "Not Found", "user does not exist")

	if w.Code != 404 {
		t.Fatalf("status: got %d, want 404", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/problem+json" {
		t.Fatalf("content-type: got %q, want %q", ct, "application/problem+json")
	}

	var body Problem
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if body.Type != "about:blank" || body.Title != "Not Found" || body.Status != 404 || body.Detail != "user does not exist" {
		t.Fatalf("body: got %+v", body)
	}
}
