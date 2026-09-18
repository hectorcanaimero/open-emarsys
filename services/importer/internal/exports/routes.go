// Package exports holds the contact export routes and job handler (F1.4.T3).
package exports

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"github.com/google/uuid"

	"github.com/open-emarsys/oe/libs/go/oe/auth"
	"github.com/open-emarsys/oe/libs/go/oe/config"
	"github.com/open-emarsys/oe/libs/go/oe/httpx"
	"github.com/open-emarsys/oe/libs/go/oe/tenant"
	"github.com/open-emarsys/oe/services/importer/internal/jobs"
)

// Kind is the job kind the export handler is registered for.
const Kind = "export"

const maxFields = 500 // the stream contract's limit

var scopeRe = regexp.MustCompile(`^(all|list:[0-9a-fA-F-]{36})$`)

// Params is what the job row keeps in `params`: resolved field IDs, scope and format.
type Params struct {
	Fields []int  `json:"fields"`
	Scope  string `json:"scope"`
	Format string `json:"format"`
}

type request struct {
	Fields []json.RawMessage `json:"fields"` // field IDs or api_names
	Scope  string            `json:"scope"`
	Format string            `json:"format"`
}

type badRequest struct {
	code int // public replyCode
	msg  string
}

func (e badRequest) Error() string { return e.msg }

type handler struct {
	env  *jobs.Env
	core *coreAPI
	ttl  time.Duration // lifetime of result_url
}

// Register mounts the export routes and registers the export job handler.
func Register(mux *http.ServeMux, env *jobs.Env) {
	ttl := config.New("IMPORTER").Duration("EXPORT_URL_TTL", 24*time.Hour)
	h := &handler{env: env, core: newCoreAPI(env.CoreURL, env.CoreTokens), ttl: ttl}
	env.Queue.Handle(Kind, h.run)

	view := env.Verifier.Require("contacts:view")
	mux.Handle("POST /admin/v1/exports", view(http.HandlerFunc(h.admin)))
	mux.Handle("POST /api/v3/export", view(http.HandlerFunc(h.public)))
}

func subject(r *http.Request) string {
	if p, ok := auth.PrincipalFrom(r.Context()); ok {
		return p.Subject
	}
	return ""
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// create validates the request against core's fields and queues the job.
func (h *handler) create(r *http.Request) (uuid.UUID, error) {
	tid, ok := tenant.TenantFrom(r.Context())
	if !ok {
		return uuid.Nil, errNoTenant
	}
	var in request
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&in); err != nil {
		return uuid.Nil, badRequest{1001, "invalid JSON body: " + err.Error()}
	}
	if in.Format == "" {
		in.Format = "csv"
	}
	if in.Format != "csv" {
		return uuid.Nil, badRequest{1001, "format must be csv"}
	}
	if in.Scope == "" {
		in.Scope = "all"
	}
	if !scopeRe.MatchString(in.Scope) {
		return uuid.Nil, badRequest{1001, "scope must be all or list:<uuid>"}
	}
	if n := len(in.Fields); n == 0 || n > maxFields {
		return uuid.Nil, badRequest{1001, fmt.Sprintf("fields must have 1-%d entries", maxFields)}
	}
	meta, err := h.core.fields(r.Context(), tid)
	if err != nil {
		return uuid.Nil, err
	}
	ids := make([]int, 0, len(in.Fields))
	for _, raw := range in.Fields {
		f, ok := meta.lookup(raw)
		if !ok {
			return uuid.Nil, badRequest{2011, "unknown field " + string(raw)}
		}
		ids = append(ids, f.FieldID)
	}
	return h.env.Store.Enqueue(r.Context(), Kind, Params{Fields: ids, Scope: in.Scope, Format: in.Format}, subject(r))
}

var errNoTenant = errors.New("exports: tenant-scoped token required")

func (h *handler) admin(w http.ResponseWriter, r *http.Request) {
	id, err := h.create(r)
	var bad badRequest
	switch {
	case errors.As(err, &bad):
		httpx.WriteProblem(w, http.StatusBadRequest, "Bad Request", bad.msg)
	case errors.Is(err, errNoTenant):
		httpx.WriteProblem(w, http.StatusForbidden, "Forbidden", err.Error())
	case err != nil:
		httpx.WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "an unexpected error occurred")
	default:
		j, err := h.env.Store.Get(r.Context(), id)
		if err != nil {
			httpx.WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "an unexpected error occurred")
			return
		}
		writeJSON(w, http.StatusAccepted, j)
	}
}

func (h *handler) public(w http.ResponseWriter, r *http.Request) {
	id, err := h.create(r)
	var bad badRequest
	switch {
	case errors.As(err, &bad):
		writeJSON(w, http.StatusBadRequest, httpx.Envelope{ReplyCode: bad.code, ReplyText: bad.msg})
	case errors.Is(err, errNoTenant):
		httpx.WriteProblem(w, http.StatusForbidden, "Forbidden", err.Error())
	case err != nil:
		httpx.WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "an unexpected error occurred")
	default:
		writeJSON(w, http.StatusAccepted, httpx.Envelope{ReplyText: "OK", Data: map[string]any{"job_id": id}})
	}
}

// notify publishes system.job.completed. A failed publish is logged, never fails the job.
func (h *handler) notify(ctx context.Context, j *jobs.Job, out jobs.Outcome, jobErr error) {
	if h.env.Events == nil {
		return
	}
	data := map[string]any{"job_id": j.ID, "kind": Kind, "status": jobs.StatusSucceeded, "result_url": nil, "expires_at": nil, "error": nil}
	if jobErr != nil {
		data["status"], data["error"] = jobs.StatusFailed, jobErr.Error()
	} else {
		data["result_url"] = out.ResultURL
		data["expires_at"] = time.Now().Add(h.ttl).UTC().Format(time.RFC3339)
	}
	if _, err := h.env.Events.Publish(ctx, "system.job.completed", j.TenantID, nil, data); err != nil {
		slog.ErrorContext(ctx, "publish system.job.completed", "job_id", j.ID, "error", err)
	}
}

func (m fieldMeta) lookup(raw json.RawMessage) (field, bool) {
	var name string
	if json.Unmarshal(raw, &name) != nil { // a JSON number
		name = string(raw)
	}
	id, _ := strconv.Atoi(name)
	for _, f := range m.Fields {
		if f.FieldID == id || f.APIName == name {
			return f, true
		}
	}
	return field{}, false
}
