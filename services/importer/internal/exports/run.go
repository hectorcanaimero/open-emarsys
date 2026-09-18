package exports

import (
	"bufio"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/minio/minio-go/v7"

	"github.com/open-emarsys/oe/services/importer/internal/jobs"
	"github.com/open-emarsys/oe/services/importer/internal/storage"
)

// flushRows is how many rows are counted before progress is handed to the reporter.
const flushRows = 1000

// run is the job handler: export, then tell the console how it went.
func (h *handler) run(ctx context.Context, j *jobs.Job, rep *jobs.Reporter) (jobs.Outcome, error) {
	out, err := h.export(ctx, j, rep)
	if ctx.Err() == nil { // shutting down: the job is recovered as an orphan, no notice yet
		h.notify(ctx, j, out, err)
	}
	return out, err
}

func (h *handler) export(ctx context.Context, j *jobs.Job, rep *jobs.Reporter) (jobs.Outcome, error) {
	var p Params
	if err := json.Unmarshal(j.Params, &p); err != nil {
		return jobs.Outcome{}, err
	}
	meta, err := h.core.fields(ctx, j.TenantID)
	if err != nil {
		return jobs.Outcome{}, err
	}
	cols, err := columns(meta, p.Fields)
	if err != nil {
		return jobs.Outcome{}, err
	}
	listID, _ := strings.CutPrefix(p.Scope, "list:")
	if p.Scope == "all" {
		listID = ""
	}
	body, err := h.core.stream(ctx, j.TenantID, p.Fields, listID)
	if err != nil {
		return jobs.Outcome{}, err
	}
	defer body.Close()

	// CSV is produced into a pipe that a multipart upload drains: memory stays at one part.
	// A stream that fails midway aborts the upload, so no partial file is ever published.
	pr, pw := io.Pipe()
	go func() { pw.CloseWithError(writeCSV(pw, body, cols, rep)) }()
	key := fmt.Sprintf("%s/%s.csv", j.TenantID, j.ID)
	_, err = h.env.Storage.PutObject(ctx, storage.BucketExports, key, pr, -1, minio.PutObjectOptions{
		ContentType: "text/csv; charset=utf-8",
		PartSize:    8 << 20, // unset, minio-go sizes parts for a 5 TiB object (~500 MB each)
		NumThreads:  1,
	})
	pr.CloseWithError(err) // unblocks the writer when the upload failed first
	if err != nil {
		return jobs.Outcome{}, err
	}
	url, err := h.env.Storage.PresignGet(ctx, storage.BucketExports, key, h.ttl)
	return jobs.Outcome{ResultURL: url}, err
}

// column renders one exported field: its api_name header and how a stored value prints.
type column struct {
	id     int
	name   string
	labels map[int]string // option ID -> label in the tenant locale; nil unless a choice field
}

func columns(meta fieldMeta, ids []int) ([]column, error) {
	byID := make(map[int]field, len(meta.Fields))
	for _, f := range meta.Fields {
		byID[f.FieldID] = f
	}
	cols := make([]column, len(ids))
	for i, id := range ids {
		f, ok := byID[id]
		if !ok {
			return nil, fmt.Errorf("field %d no longer exists", id)
		}
		cols[i] = column{id: id, name: f.APIName}
		if strings.HasSuffix(f.Type, "_choice") {
			cols[i].labels = make(map[int]string, len(f.Choices))
			for _, c := range f.Choices {
				l := c.Labels[meta.DefaultLocale]
				if l == "" {
					l = strconv.Itoa(c.ID)
				}
				cols[i].labels[c.ID] = l
			}
		}
	}
	return cols, nil
}

func (c column) render(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	switch raw[0] {
	case '"':
		var s string
		_ = json.Unmarshal(raw, &s)
		return s
	case '[': // multi_choice
		var ids []int
		if json.Unmarshal(raw, &ids) != nil {
			return string(raw)
		}
		out := make([]string, len(ids))
		for i, id := range ids {
			out[i] = c.label(id)
		}
		return strings.Join(out, "; ")
	}
	if id, err := strconv.Atoi(string(raw)); err == nil && c.labels != nil {
		return c.label(id)
	}
	return string(raw)
}

func (c column) label(id int) string {
	if l, ok := c.labels[id]; ok {
		return l
	}
	return strconv.Itoa(id)
}

// writeCSV converts the NDJSON stream to CSV. Per the stream contract a body that ends without
// a final newline is truncated, which is an error.
func writeCSV(w io.Writer, ndjson io.Reader, cols []column, rep *jobs.Reporter) error {
	cw := csv.NewWriter(w)
	head := make([]string, len(cols))
	keys := make([]string, len(cols))
	for i, c := range cols {
		head[i], keys[i] = c.name, strconv.Itoa(c.id)
	}
	if err := cw.Write(head); err != nil {
		return err
	}
	br := bufio.NewReaderSize(ndjson, 64<<10)
	row := make([]string, len(cols))
	var pending int64
	for {
		line, err := br.ReadBytes('\n')
		if err != nil {
			if errors.Is(err, io.EOF) && len(line) == 0 {
				break
			}
			if errors.Is(err, io.EOF) {
				err = errors.New("contact stream truncated: no final newline")
			}
			return err
		}
		var c struct {
			Fields map[string]json.RawMessage `json:"fields"`
		}
		if err := json.Unmarshal(line, &c); err != nil {
			return fmt.Errorf("bad contact line: %w", err)
		}
		for i, col := range cols {
			row[i] = col.render(c.Fields[keys[i]])
		}
		if err := cw.Write(row); err != nil {
			return err
		}
		if pending++; pending == flushRows {
			rep.Add(pending, pending, 0)
			pending = 0
		}
	}
	rep.Add(pending, pending, 0)
	cw.Flush()
	return cw.Error()
}
