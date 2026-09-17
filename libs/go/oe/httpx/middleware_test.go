package httpx

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRecoverMiddleware(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	panicking := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("boom")
	})

	handler := Recover(logger)(panicking)

	req := httptest.NewRequest(http.MethodGet, "/explode", nil)
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status: got %d, want %d", w.Code, http.StatusInternalServerError)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/problem+json" {
		t.Fatalf("content-type: got %q, want %q", ct, "application/problem+json")
	}

	var body Problem
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if body.Status != http.StatusInternalServerError || body.Title == "" {
		t.Fatalf("body: got %+v", body)
	}
}

func TestRecoverMiddlewarePassesThroughWithoutPanic(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	})

	handler := Recover(logger)(ok)

	req := httptest.NewRequest(http.MethodGet, "/fine", nil)
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, req)

	if w.Code != http.StatusTeapot {
		t.Fatalf("status: got %d, want %d", w.Code, http.StatusTeapot)
	}
}
