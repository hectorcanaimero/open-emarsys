// Package imports holds the CSV import routes and job handler (F1.4.T2).
package imports

import (
	"net/http"

	"github.com/open-emarsys/oe/libs/go/oe/httpx"
	"github.com/open-emarsys/oe/services/importer/internal/jobs"
)

// Register mounts the import routes and registers the import job handler.
// Stub until F1.4.T2: main.go already calls it, so T2 only replaces this file.
func Register(mux *http.ServeMux, env *jobs.Env) {
	notImplemented := func(w http.ResponseWriter, r *http.Request) {
		httpx.WriteProblem(w, http.StatusNotImplemented, "Not Implemented", "imports arrive with F1.4.T2")
	}
	mux.HandleFunc("POST /admin/v1/imports/upload-url", notImplemented)
	mux.HandleFunc("POST /admin/v1/imports", notImplemented)
	mux.HandleFunc("POST /admin/v1/imports/{id}/preview", notImplemented)
	mux.HandleFunc("POST /admin/v1/imports/{id}/start", notImplemented)
	mux.HandleFunc("POST /api/v3/import", notImplemented)
}
