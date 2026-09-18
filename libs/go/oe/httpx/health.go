package httpx

import (
	"context"
	"net/http"
)

// Checker reports whether a dependency is ready.
type Checker func(ctx context.Context) error

// Healthz always reports 200: the process is up and can serve requests.
func Healthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

// Readyz runs checks and reports 200 only if all of them succeed, otherwise
// a 503 problem naming the first failure.
func Readyz(checks ...Checker) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		for _, check := range checks {
			if err := check(r.Context()); err != nil {
				WriteProblem(w, http.StatusServiceUnavailable, "Not Ready", err.Error())
				return
			}
		}
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}
}
