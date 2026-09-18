// Package imports holds the CSV import routes and job handler (F1.4.T2).
package imports

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"

	"github.com/open-emarsys/oe/libs/go/oe/auth"
	"github.com/open-emarsys/oe/libs/go/oe/httpx"
	"github.com/open-emarsys/oe/libs/go/oe/tenant"
	"github.com/open-emarsys/oe/services/importer/internal/jobs"
	"github.com/open-emarsys/oe/services/importer/internal/storage"
)

// Kind is the job kind the import handler is registered for.
const Kind = "import"

const uploadExpiry = 15 * time.Minute

var (
	keyIDRe  = regexp.MustCompile(`^(id|[1-9][0-9]*)$`)
	targetRe = regexp.MustCompile(`^(contacts|list:[0-9a-fA-F-]{36}|relational:[0-9a-fA-F-]{36})$`)
)

// Params is what the job row keeps in `params`: the upload plus the resolved CSV options.
type Params struct {
	ObjectKey string            `json:"object_key"`
	Filename  string            `json:"filename,omitempty"`
	Delimiter string            `json:"delimiter"`
	Encoding  string            `json:"encoding"`
	HasHeader bool              `json:"has_header"`
	Mapping   map[string]string `json:"mapping"`
	KeyID     string            `json:"key_id"`
	Mode      string            `json:"mode"`
	Target    string            `json:"target"`
}

type startReq struct {
	Delimiter string            `json:"delimiter"`
	Encoding  string            `json:"encoding"`
	HasHeader *bool             `json:"has_header"`
	Mapping   map[string]string `json:"mapping"`
	KeyID     string            `json:"key_id"`
	Mode      string            `json:"mode"`
	Target    string            `json:"target"`
}

// draft is the marker object kept in MinIO for an import that is created but not started:
// importer.jobs has no `draft` status, so drafts live next to the upload until /start.
type draft struct {
	ObjectKey string     `json:"object_key"`
	Filename  string     `json:"filename"`
	CreatedBy string     `json:"created_by"`
	CreatedAt time.Time  `json:"created_at"`
	JobID     *uuid.UUID `json:"job_id,omitempty"` // set once started
}

type badRequest string

func (e badRequest) Error() string { return string(e) }

type handler struct {
	env *jobs.Env
	cfg config
	lim *limiter
}

// Register mounts the import routes and registers the import job handler.
func Register(mux *http.ServeMux, env *jobs.Env) {
	h := &handler{env: env, cfg: defaultConfig(), lim: newLimiter(defaultConfig().TenantBatches)}
	env.Queue.Handle(Kind, h.run)

	edit := env.Verifier.Require("contacts:edit")
	mux.Handle("POST /admin/v1/imports/upload-url", edit(http.HandlerFunc(h.uploadURL)))
	mux.Handle("POST /admin/v1/imports", edit(http.HandlerFunc(h.create)))
	mux.Handle("POST /admin/v1/imports/{id}/preview", edit(http.HandlerFunc(h.preview)))
	mux.Handle("POST /admin/v1/imports/{id}/start", edit(http.HandlerFunc(h.start)))
	mux.Handle("POST /admin/v1/jobs/{id}/cancel", edit(http.HandlerFunc(h.cancel)))
	mux.Handle("POST /api/v3/import", edit(http.HandlerFunc(h.publicImport)))
}

func tenantOf(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	tid, ok := tenant.TenantFrom(r.Context())
	if !ok {
		httpx.WriteProblem(w, http.StatusForbidden, "Forbidden", "a tenant-scoped token is required")
	}
	return tid, ok
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

func problem(w http.ResponseWriter, err error) {
	var bad badRequest
	switch {
	case errors.As(err, &bad):
		httpx.WriteProblem(w, http.StatusBadRequest, "Bad Request", bad.Error())
	case errors.Is(err, errNotFound):
		httpx.WriteProblem(w, http.StatusNotFound, "Not Found", "not found")
	default:
		httpx.WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "an unexpected error occurred")
	}
}

var errNotFound = errors.New("imports: not found")

func decode(r *http.Request, v any) error {
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(v); err != nil {
		return badRequest("invalid JSON body: " + err.Error())
	}
	return nil
}

func (h *handler) uploadURL(w http.ResponseWriter, r *http.Request) {
	tid, ok := tenantOf(w, r)
	if !ok {
		return
	}
	var in struct {
		Filename    string `json:"filename"`
		ContentType string `json:"content_type"`
	}
	if err := decode(r, &in); err != nil {
		problem(w, err)
		return
	}
	name := safeName(in.Filename)
	if name == "" || len(in.Filename) > 255 {
		problem(w, badRequest("filename is required (max 255 characters)"))
		return
	}
	key := newObjectKey(tid, name)
	url, err := h.env.Storage.PresignPut(r.Context(), storage.BucketImports, key, uploadExpiry)
	if err != nil {
		problem(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"url": url, "object_key": key, "expires_at": time.Now().Add(uploadExpiry).UTC(),
	})
}

func safeName(n string) string {
	n = path.Base(strings.ReplaceAll(strings.TrimSpace(n), "\\", "/"))
	if n == "." || n == "/" {
		return ""
	}
	return n
}

func newObjectKey(tid uuid.UUID, name string) string {
	return fmt.Sprintf("%s/uploads/%s/%s", tid, uuid.New(), name)
}

func draftKey(tid, id uuid.UUID) string { return fmt.Sprintf("%s/drafts/%s.json", tid, id) }

func (h *handler) create(w http.ResponseWriter, r *http.Request) {
	tid, ok := tenantOf(w, r)
	if !ok {
		return
	}
	var in struct {
		ObjectKey string `json:"object_key"`
		Filename  string `json:"filename"`
	}
	if err := decode(r, &in); err != nil {
		problem(w, err)
		return
	}
	// The key must be inside this tenant's uploads: never let one tenant name another's object.
	if !strings.HasPrefix(in.ObjectKey, tid.String()+"/uploads/") || strings.Contains(in.ObjectKey, "..") {
		problem(w, badRequest("object_key was not issued for this tenant"))
		return
	}
	if _, err := h.env.Storage.StatObject(r.Context(), storage.BucketImports, in.ObjectKey, minio.StatObjectOptions{}); err != nil {
		if minio.ToErrorResponse(err).StatusCode == http.StatusNotFound {
			err = errNotFound
		}
		problem(w, err)
		return
	}
	if in.Filename == "" {
		in.Filename = path.Base(in.ObjectKey)
	}
	id, _ := uuid.NewV7()
	d := draft{ObjectKey: in.ObjectKey, Filename: in.Filename, CreatedBy: subject(r), CreatedAt: time.Now().UTC()}
	if err := h.putDraft(r.Context(), tid, id, d); err != nil {
		problem(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, draftJob(tid, id, d))
}

func draftJob(tid, id uuid.UUID, d draft) *jobs.Job {
	p, _ := json.Marshal(map[string]string{"object_key": d.ObjectKey, "filename": d.Filename})
	return &jobs.Job{ID: id, TenantID: tid, Kind: Kind, Status: "draft", Params: p, CreatedBy: d.CreatedBy, CreatedAt: d.CreatedAt}
}

func (h *handler) putDraft(ctx context.Context, tid, id uuid.UUID, d draft) error {
	raw, _ := json.Marshal(d)
	_, err := h.env.Storage.PutObject(ctx, storage.BucketImports, draftKey(tid, id), bytes.NewReader(raw), int64(len(raw)),
		minio.PutObjectOptions{ContentType: "application/json"})
	return err
}

func (h *handler) loadDraft(w http.ResponseWriter, r *http.Request) (tid, id uuid.UUID, d draft, ok bool) {
	if tid, ok = tenantOf(w, r); !ok {
		return
	}
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		problem(w, errNotFound)
		return tid, id, d, false
	}
	obj, err := h.env.Storage.GetObject(r.Context(), storage.BucketImports, draftKey(tid, id), minio.GetObjectOptions{})
	if err == nil {
		defer obj.Close()
		err = json.NewDecoder(obj).Decode(&d)
	}
	if err != nil {
		if minio.ToErrorResponse(err).StatusCode == http.StatusNotFound {
			err = errNotFound
		}
		problem(w, err)
		return tid, id, d, false
	}
	return tid, id, d, true
}

func (h *handler) preview(w http.ResponseWriter, r *http.Request) {
	_, _, d, ok := h.loadDraft(w, r)
	if !ok {
		return
	}
	if d.JobID != nil {
		httpx.WriteProblem(w, http.StatusConflict, "Conflict", "the import was already started")
		return
	}
	var opt startReq
	if r.ContentLength != 0 {
		if err := decode(r, &opt); err != nil && !errors.Is(err, io.EOF) {
			problem(w, err)
			return
		}
	}
	hasHeader := opt.HasHeader == nil || *opt.HasHeader
	out, err := h.buildPreview(r.Context(), d.ObjectKey, opt.Delimiter, opt.Encoding, hasHeader)
	if err != nil {
		problem(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *handler) start(w http.ResponseWriter, r *http.Request) {
	tid, id, d, ok := h.loadDraft(w, r)
	if !ok {
		return
	}
	if d.JobID != nil {
		httpx.WriteProblem(w, http.StatusConflict, "Conflict", "the import was already started")
		return
	}
	var in startReq
	if err := decode(r, &in); err != nil {
		problem(w, err)
		return
	}
	jobID, err := h.enqueue(r.Context(), subject(r), d.ObjectKey, d.Filename, in)
	if err != nil {
		problem(w, err)
		return
	}
	d.JobID = &jobID
	_ = h.putDraft(r.Context(), tid, id, d) // marks the draft consumed; a failure only allows a second start
	j, err := h.env.Store.Get(r.Context(), jobID)
	if err != nil {
		problem(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, j)
}

func (h *handler) cancel(w http.ResponseWriter, r *http.Request) {
	if _, ok := tenantOf(w, r); !ok {
		return
	}
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		problem(w, errNotFound)
		return
	}
	j, err := h.env.Store.Cancel(r.Context(), id)
	switch {
	case errors.Is(err, jobs.ErrNotFound):
		problem(w, errNotFound)
	case errors.Is(err, jobs.ErrFinished):
		httpx.WriteProblem(w, http.StatusConflict, "Conflict", "the job already finished")
	case err != nil:
		problem(w, err)
	default:
		writeJSON(w, http.StatusAccepted, j)
	}
}

// publicImport is POST /api/v3/import. The file part is streamed straight into MinIO, so the
// upload never sits in memory; the other parts are small form fields.
func (h *handler) publicImport(w http.ResponseWriter, r *http.Request) {
	tid, ok := tenantOf(w, r)
	if !ok {
		return
	}
	fail := func(code int, text string) {
		writeJSON(w, http.StatusBadRequest, httpx.Envelope{ReplyCode: code, ReplyText: text})
	}
	mr, err := r.MultipartReader()
	if err != nil {
		fail(1001, "multipart/form-data body required")
		return
	}
	var (
		in       startReq
		key      string
		filename string
		hasFile  bool
	)
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			fail(1001, "malformed multipart body")
			return
		}
		switch part.FormName() {
		case "file":
			filename = safeName(part.FileName())
			if filename == "" {
				filename = "import.csv"
			}
			key = newObjectKey(tid, filename)
			_, err = h.env.Storage.PutObject(r.Context(), storage.BucketImports, key, part, -1,
				minio.PutObjectOptions{ContentType: "text/csv", PartSize: 16 << 20})
			if err != nil {
				fail(1001, "could not store the file")
				return
			}
			hasFile = true
		default:
			val, _ := io.ReadAll(io.LimitReader(part, 1<<20))
			s := strings.TrimSpace(string(val))
			switch part.FormName() {
			case "mapping":
				if err := json.Unmarshal(val, &in.Mapping); err != nil {
					fail(1001, "mapping must be a JSON object of column name to field ID")
					h.discard(key)
					return
				}
			case "key_id":
				in.KeyID = s
			case "mode":
				in.Mode = s
			case "target":
				in.Target = s
			}
		}
	}
	if !hasFile {
		fail(1001, "file part is required")
		return
	}
	jobID, err := h.enqueue(r.Context(), subject(r), key, filename, in)
	if err != nil {
		h.discard(key)
		var bad badRequest
		if errors.As(err, &bad) {
			fail(1001, bad.Error())
		} else {
			httpx.WriteProblem(w, http.StatusInternalServerError, "Internal Server Error", "an unexpected error occurred")
		}
		return
	}
	writeJSON(w, http.StatusAccepted, httpx.Envelope{ReplyText: "OK", Data: map[string]any{"job_id": jobID}})
}

func (h *handler) discard(key string) {
	if key != "" {
		_ = h.env.Storage.RemoveObject(context.Background(), storage.BucketImports, key, minio.RemoveObjectOptions{})
	}
}

// enqueue validates the start request, fills in the detected CSV options and queues the job.
func (h *handler) enqueue(ctx context.Context, by, objectKey, filename string, in startReq) (uuid.UUID, error) {
	if !keyIDRe.MatchString(in.KeyID) {
		return uuid.Nil, badRequest("key_id must be a field ID or 'id'")
	}
	if in.Mode != "create" && in.Mode != "update" && in.Mode != "upsert" {
		return uuid.Nil, badRequest("mode must be create, update or upsert")
	}
	if !targetRe.MatchString(in.Target) {
		return uuid.Nil, badRequest("target must be contacts, list:<uuid> or relational:<uuid>")
	}
	if len(in.Mapping) == 0 {
		return uuid.Nil, badRequest("mapping must map at least one column")
	}
	keyMapped := false
	for col, dest := range in.Mapping {
		if col == "" || dest == "" {
			return uuid.Nil, badRequest("mapping entries need a column name and a destination")
		}
		keyMapped = keyMapped || dest == in.KeyID
	}
	if !keyMapped {
		return uuid.Nil, badRequest("no column is mapped to key_id " + in.KeyID)
	}
	hasHeader := in.HasHeader == nil || *in.HasHeader
	p := Params{ObjectKey: objectKey, Filename: filename, HasHeader: hasHeader, Mapping: in.Mapping,
		KeyID: in.KeyID, Mode: in.Mode, Target: in.Target}
	var err error
	if p.Delimiter, p.Encoding, err = h.resolveOptions(ctx, objectKey, in.Delimiter, in.Encoding); err != nil {
		return uuid.Nil, err
	}
	return h.env.Store.Enqueue(ctx, Kind, p, by)
}
