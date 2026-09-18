// Package exports holds the contact export routes and job handler (F1.4.T3).
package exports

import (
	"net/http"

	"github.com/open-emarsys/oe/libs/go/oe/httpx"
	"github.com/open-emarsys/oe/services/importer/internal/jobs"
)

// Register mounts the export routes and registers the export job handler.
// Stub until F1.4.T3: main.go already calls it, so T3 only replaces this file.
func Register(mux *http.ServeMux, env *jobs.Env) {
	notImplemented := func(w http.ResponseWriter, r *http.Request) {
		httpx.WriteProblem(w, http.StatusNotImplemented, "Not Implemented", "exports arrive with F1.4.T3")
	}
	mux.HandleFunc("POST /admin/v1/exports", notImplemented)
	mux.HandleFunc("POST /api/v3/export", notImplemented)
}
