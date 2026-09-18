package exports

import (
	"bufio"
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"

	"github.com/open-emarsys/oe/services/importer/internal/jobs"
	"github.com/open-emarsys/oe/services/importer/internal/storage"
)

const eventType = "system.job.completed"

// Publisher publishes C1 events; natsx.Client satisfies it.
type Publisher interface {
	Publish(ctx context.Context, eventType string, tenantID uuid.UUID, contactID *uuid.UUID, data any) (string, error)
}

// Events receives system.job.completed. main.go does not wire NATS yet (it is outside this
// task's files): set it to a natsx.Client there. Nil means the notice is only logged.
var Events Publisher

type params struct {
	Scope   string   `json:"scope"`
	Columns []column `json:"columns"`
}

func newHandler(env *jobs.Env, ttl time.Duration) jobs.Handler {
	return func(ctx context.Context, j *jobs.Job, rep *jobs.Reporter) (jobs.Outcome, error) {
		key := j.TenantID.String() + "/" + j.ID.String() + ".csv"
		out, rows, err := run(ctx, env, ttl, j, key, rep)
		done := map[string]any{
			"job_id": j.ID, "kind": kind, "status": "succeeded", "created_by": j.CreatedBy,
			"rows_read": rows, "result_url": nil, "result_url_expires_at": nil, "error": nil,
		}
		if err != nil {
			done["status"], done["error"] = "failed", err.Error()
		} else {
			done["result_url"], done["result_url_expires_at"] = out.ResultURL, time.Now().Add(ttl).UTC().Format(time.RFC3339)
		}
		if ctx.Err() == nil { // worker going down: the job is retried, no notice yet
			notify(ctx, j.TenantID, done)
		}
		return out, err
	}
}

func notify(ctx context.Context, tenantID uuid.UUID, data map[string]any) {
	if Events == nil {
		slog.WarnContext(ctx, "no event publisher wired; job completion not published", "job_id", data["job_id"])
		return
	}
	if _, err := Events.Publish(ctx, eventType, tenantID, nil, data); err != nil {
		slog.ErrorContext(ctx, "publish "+eventType, "job_id", data["job_id"], "error", err)
	}
}

func run(ctx context.Context, env *jobs.Env, ttl time.Duration, j *jobs.Job, key string, rep *jobs.Reporter) (jobs.Outcome, int64, error) {
	var p params
	if err := json.Unmarshal(j.Params, &p); err != nil || len(p.Columns) == 0 {
		return jobs.Outcome{}, 0, errors.New("invalid export params")
	}
	ids := make([]string, len(p.Columns))
	for i, c := range p.Columns {
		ids[i] = strconv.Itoa(c.ID)
	}
	var body io.ReadCloser
	var err error
	if listID, ok := strings.CutPrefix(p.Scope, "list:"); ok {
		body, err = env.Core.StreamContactsInList(ctx, j.TenantID.String(), ids, listID)
	} else {
		body, err = env.Core.StreamContacts(ctx, j.TenantID.String(), ids)
	}
	if err != nil {
		return jobs.Outcome{}, 0, err
	}
	defer body.Close()

	// The CSV goes through a pipe into a multipart upload: memory stays at one part.
	pr, pw := io.Pipe()
	uploaded := make(chan error, 1)
	go func() {
		_, err := env.Storage.PutObject(ctx, storage.BucketExports, key, pr, -1,
			minio.PutObjectOptions{ContentType: "text/csv", PartSize: 5 << 20, NumThreads: 1})
		pr.CloseWithError(err) // unblocks the writer if the upload died first
		uploaded <- err
	}()
	rows, werr := writeCSV(pw, body, p.Columns, rep)
	pw.CloseWithError(werr) // nil ends the object; an error aborts the multipart upload
	uerr := <-uploaded
	if werr != nil {
		return jobs.Outcome{}, rows, werr
	}
	if uerr != nil {
		return jobs.Outcome{}, rows, fmt.Errorf("upload export: %w", uerr)
	}
	url, err := env.Storage.PresignGet(ctx, storage.BucketExports, key, ttl)
	if err != nil {
		return jobs.Outcome{}, rows, err
	}
	return jobs.Outcome{ResultURL: url}, rows, nil
}

// writeCSV turns the NDJSON stream into CSV: api_name header, then one row per contact.
func writeCSV(w io.Writer, ndjson io.Reader, cols []column, rep *jobs.Reporter) (int64, error) {
	cw := csv.NewWriter(w)
	head := make([]string, len(cols))
	for i, c := range cols {
		head[i] = c.APIName
	}
	if err := cw.Write(head); err != nil {
		return 0, err
	}
	br := bufio.NewReaderSize(ndjson, 64<<10)
	row := make([]string, len(cols))
	var n int64
	for {
		line, err := br.ReadBytes('\n')
		if err == io.EOF && len(line) > 0 {
			return n, errors.New("contact stream truncated (no final newline)")
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return n, err
		}
		var c struct {
			Fields map[string]json.RawMessage `json:"fields"`
		}
		if err := json.Unmarshal(line, &c); err != nil {
			return n, fmt.Errorf("bad contact line: %w", err)
		}
		for i, col := range cols {
			row[i] = cell(col, c.Fields[strconv.Itoa(col.ID)])
		}
		if err := cw.Write(row); err != nil {
			return n, err
		}
		if n++; n%1000 == 0 {
			rep.Add(1000, 1000, 0)
		}
	}
	rep.Add(n%1000, n%1000, 0)
	cw.Flush()
	return n, cw.Error()
}

// cell renders one value: choice IDs become labels (multi choice joined with ";"), and text
// that a spreadsheet would run as a formula gets a leading quote.
func cell(c column, raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	if raw[0] == '[' {
		var ids []json.Number
		if json.Unmarshal(raw, &ids) != nil {
			return string(raw)
		}
		labels := make([]string, len(ids))
		for i, id := range ids {
			labels[i] = label(c, id.String())
		}
		return strings.Join(labels, ";")
	}
	if raw[0] == '"' {
		var s string
		if json.Unmarshal(raw, &s) != nil {
			return string(raw)
		}
		if s != "" && strings.ContainsRune("=+-@\t\r", rune(s[0])) {
			return "'" + s
		}
		return s
	}
	return label(c, string(bytes.TrimSpace(raw))) // numbers and booleans verbatim; choice IDs by label
}

func label(c column, id string) string {
	if l, ok := c.Choices[id]; ok {
		return l
	}
	return id
}
