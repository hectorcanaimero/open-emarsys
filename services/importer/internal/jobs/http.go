package jobs

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/google/uuid"

	"github.com/open-emarsys/oe/libs/go/oe/auth"
	"github.com/open-emarsys/oe/libs/go/oe/httpx"
	"github.com/open-emarsys/oe/libs/go/oe/pg"
)

// Routes registers the job read APIs: GET /api/v3/jobs/{id} (C2 envelope, scope jobs:view)
// and GET /admin/v1/jobs[/{id}] (C3 plain JSON, permission contacts:view).
func Routes(mux *http.ServeMux, s *Store, v *auth.Verifier) {
	pub := v.Require("jobs:view")
	adm := v.Require("contacts:view")
	mux.Handle("GET /api/v3/jobs/{id}", pub(http.HandlerFunc(s.publicGet)))
	mux.Handle("GET /admin/v1/jobs", adm(http.HandlerFunc(s.adminList)))
	mux.Handle("GET /admin/v1/jobs/{id}", adm(http.HandlerFunc(s.adminGet)))
}

func (s *Store) publicGet(w http.ResponseWriter, r *http.Request) {
	j, ok := s.load(w, r, true)
	if !ok {
		return
	}
	httpx.WriteEnvelope(w, 0, "OK", map[string]any{
		"id": j.ID, "kind": j.Kind, "status": j.Status, "progress": j.Progress.Percent,
		"result_url": j.ResultURL, "error_report_url": j.ErrorReportURL,
	})
}

func (s *Store) adminGet(w http.ResponseWriter, r *http.Request) {
	if j, ok := s.load(w, r, false); ok {
		writeJSON(w, http.StatusOK, j)
	}
}

func (s *Store) adminList(w http.ResponseWriter, r *http.Request) {
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 200 {
			httpx.WriteProblem(w, http.StatusBadRequest, "Bad Request", "limit must be 1-200")
			return
		}
		limit = n
	}
	items, next, err := s.List(r.Context(), r.URL.Query().Get("cursor"), limit)
	if err != nil {
		fail(w, err)
		return
	}
	if items == nil {
		items = []*Job{}
	}
	var nc *string
	if next != "" {
		nc = &next
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "next_cursor": nc})
}

// load resolves {id} for the caller's tenant; a job of another tenant is a plain 404.
func (s *Store) load(w http.ResponseWriter, r *http.Request, envelope bool) (*Job, bool) {
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		if envelope {
			writeJSON(w, http.StatusBadRequest, httpx.Envelope{ReplyCode: 1001, ReplyText: "Invalid job id"})
		} else {
			httpx.WriteProblem(w, http.StatusBadRequest, "Bad Request", "invalid job id")
		}
		return nil, false
	}
	j, err := s.Get(r.Context(), id)
	if errors.Is(err, ErrNotFound) {
		if envelope {
			writeJSON(w, http.StatusNotFound, httpx.Envelope{ReplyCode: 1001, ReplyText: "Job not found"})
		} else {
			httpx.WriteProblem(w, http.StatusNotFound, "Not Found", "job not found")
		}
		return nil, false
	}
	if err != nil {
		fail(w, err)
		return nil, false
	}
	return j, true
}

// fail maps a store error. Operators (no tenant) have no jobs of their own to read.
// ponytail: operator cross-tenant job view needs a tenant selector; add when the console asks.
func fail(w http.ResponseWriter, err error) {
	if errors.Is(err, pg.ErrNoTenant) {
		httpx.WriteProblem(w, http.StatusForbidden, "Forbidden", "a tenant-scoped token is required")
		return
	}
	httpx.WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "an unexpected error occurred")
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
