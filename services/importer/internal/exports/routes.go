// Package exports holds the contact export routes and job handler (F1.4.T3).
package exports

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/open-emarsys/oe/libs/go/oe/auth"
	"github.com/open-emarsys/oe/libs/go/oe/config"
	"github.com/open-emarsys/oe/libs/go/oe/httpx"
	"github.com/open-emarsys/oe/services/importer/internal/jobs"
)

const kind = "export"

var scopeRe = regexp.MustCompile(`^(all|list:[0-9a-fA-F-]{36})$`)

// Register mounts the export routes and registers the export job handler.
// The export URL lifetime is IMPORTER_EXPORT_URL_TTL (default 24h).
func Register(mux *http.ServeMux, env *jobs.Env) {
	ttl := config.New("IMPORTER").Duration("EXPORT_URL_TTL", 24*time.Hour)
	env.Queue.Handle(kind, newHandler(env, ttl))
	mux.Handle("POST /admin/v1/exports", env.Verifier.Require("contacts:admin")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Fields []int  `json:"fields"`
			Scope  string `json:"scope"`
			Format string `json:"format"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&in) != nil {
			httpx.WriteProblem(w, http.StatusBadRequest, "Bad Request", "invalid JSON body")
			return
		}
		id, err := create(r, env, true, in.Fields, in.Scope, in.Format)
		if err != nil {
			httpx.WriteProblem(w, err.status, err.title, err.msg)
			return
		}
		j, gerr := env.Store.Get(r.Context(), id)
		if gerr != nil {
			httpx.WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "an unexpected error occurred")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(j)
	})))
	mux.Handle("POST /api/v3/export", env.Verifier.Require("contacts:view")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Fields []string `json:"fields"`
			Scope  string   `json:"scope"`
			Format string   `json:"format"`
		}
		bad := func(text string) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(httpx.Envelope{ReplyCode: 1001, ReplyText: text})
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&in) != nil {
			bad("Invalid JSON body")
			return
		}
		ids := make([]int, 0, len(in.Fields))
		for _, f := range in.Fields {
			n, err := strconv.Atoi(f)
			if err != nil {
				bad("fields must be field IDs as strings")
				return
			}
			ids = append(ids, n)
		}
		id, err := create(r, env, false, ids, in.Scope, in.Format)
		if err != nil {
			if err.status >= 500 {
				httpx.WriteProblem(w, err.status, err.title, err.msg)
			} else {
				bad(err.msg)
			}
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(httpx.Envelope{ReplyText: "OK", Data: map[string]any{"job_id": id}})
	})))
}

type reqError struct {
	status     int
	title, msg string
}

func badRequest(msg string) *reqError { return &reqError{http.StatusBadRequest, "Bad Request", msg} }

// create validates the request, snapshots the selected fields' metadata (api_name, choice
// labels in the tenant's language) with the caller's own token, and enqueues the job.
func create(r *http.Request, env *jobs.Env, admin bool, ids []int, scope, format string) (uuid.UUID, *reqError) {
	if len(ids) < 1 || len(ids) > 500 {
		return uuid.Nil, badRequest("fields must hold 1 to 500 field IDs")
	}
	if !scopeRe.MatchString(scope) {
		return uuid.Nil, badRequest("scope must be all or list:<id>")
	}
	if format != "" && format != "csv" {
		return uuid.Nil, badRequest("format must be csv")
	}
	p, ok := auth.PrincipalFrom(r.Context())
	if !ok || p.TenantID == nil {
		return uuid.Nil, &reqError{http.StatusForbidden, "Forbidden", "a tenant-scoped token is required"}
	}
	token := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	var cols []column
	var err error
	if admin {
		cols, err = adminColumns(r.Context(), env, token, p.TenantID.String(), ids)
	} else {
		cols, err = publicColumns(r.Context(), env, token, ids)
	}
	if err != nil {
		if ue, ok := err.(badField); ok {
			return uuid.Nil, badRequest(ue.Error())
		}
		return uuid.Nil, &reqError{http.StatusBadGateway, "Bad Gateway", "could not read field definitions"}
	}
	params := map[string]any{"fields": ids, "scope": scope, "format": "csv", "columns": cols}
	id, err := env.Store.Enqueue(r.Context(), kind, params, p.Subject)
	if err != nil {
		return uuid.Nil, &reqError{http.StatusInternalServerError, "Internal Server Error", "an unexpected error occurred"}
	}
	return id, nil
}

type column struct {
	ID      int               `json:"id"`
	APIName string            `json:"api_name"`
	Type    string            `json:"type"`
	Choices map[string]string `json:"choices,omitempty"` // option ID -> label
}

// badField is a client mistake in fields[] (unknown or repeated ID): a 400, not a core failure.
type badField string

func (b badField) Error() string { return string(b) }

func isChoice(t string) bool { return t == "single_choice" || t == "multi_choice" }

// adminColumns reads GET /admin/v1/fields. The label locale is the tenant's default_locale;
// if the caller may not read the tenant it falls back to es.
func adminColumns(ctx context.Context, env *jobs.Env, token, tenantID string, ids []int) ([]column, error) {
	var fields struct {
		Items []struct {
			ID      int    `json:"field_id"`
			APIName string `json:"api_name"`
			Type    string `json:"type"`
			Choices []struct {
				ID     int               `json:"id"`
				Labels map[string]string `json:"labels"`
			} `json:"choices"`
		} `json:"items"`
	}
	if err := env.Core.GetAs(ctx, token, "/admin/v1/fields", &fields); err != nil {
		return nil, err
	}
	locale := "es"
	var t struct {
		DefaultLocale string `json:"default_locale"`
	}
	if env.Core.GetAs(ctx, token, "/admin/v1/tenants/"+tenantID, &t) == nil && t.DefaultLocale != "" {
		locale = t.DefaultLocale
	}
	byID := map[int]column{}
	for _, f := range fields.Items {
		c := column{ID: f.ID, APIName: f.APIName, Type: f.Type}
		if isChoice(f.Type) {
			c.Choices = map[string]string{}
			for _, ch := range f.Choices {
				c.Choices[strconv.Itoa(ch.ID)] = ch.Labels[locale]
			}
		}
		byID[f.ID] = c
	}
	return pick(ids, byID)
}

// publicColumns reads GET /api/v3/field and /field/{id}/choice, already in the tenant's locale.
func publicColumns(ctx context.Context, env *jobs.Env, token string, ids []int) ([]column, error) {
	var fields struct {
		Data []struct {
			ID       int    `json:"id"`
			Type     string `json:"application_type"`
			StringID string `json:"string_id"`
		} `json:"data"`
	}
	if err := env.Core.GetAs(ctx, token, "/api/v3/field", &fields); err != nil {
		return nil, err
	}
	byID := map[int]column{}
	for _, f := range fields.Data {
		byID[f.ID] = column{ID: f.ID, APIName: f.StringID, Type: f.Type}
	}
	for _, id := range ids {
		c, ok := byID[id]
		if !ok || !isChoice(c.Type) {
			continue
		}
		var ch struct {
			Data []struct {
				ID     int    `json:"id"`
				Choice string `json:"choice"`
			} `json:"data"`
		}
		if err := env.Core.GetAs(ctx, token, "/api/v3/field/"+strconv.Itoa(id)+"/choice", &ch); err != nil {
			return nil, err
		}
		c.Choices = map[string]string{}
		for _, o := range ch.Data {
			c.Choices[strconv.Itoa(o.ID)] = o.Choice
		}
		byID[id] = c
	}
	return pick(ids, byID)
}

func pick(ids []int, byID map[int]column) ([]column, error) {
	seen := map[int]bool{}
	cols := make([]column, 0, len(ids))
	for _, id := range ids {
		c, ok := byID[id]
		if !ok {
			return nil, badField(fmt.Sprintf("unknown field %d", id))
		}
		if seen[id] {
			return nil, badField(fmt.Sprintf("duplicate field %d", id))
		}
		seen[id] = true
		cols = append(cols, c)
	}
	return cols, nil
}
