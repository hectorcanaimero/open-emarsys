package imports

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"
	"golang.org/x/sync/errgroup"

	"github.com/open-emarsys/oe/services/importer/internal/coreclient"
	"github.com/open-emarsys/oe/services/importer/internal/jobs"
	"github.com/open-emarsys/oe/services/importer/internal/storage"
)

type config struct {
	BatchSize     int           // rows per core call
	Concurrency   int           // batches in flight per job
	TenantBatches int           // batches in flight per tenant, across jobs of this replica
	Retries       int           // extra attempts after a 5xx/429/network failure
	Backoff       time.Duration // first retry wait; doubles each attempt
	CancelCheck   time.Duration // how often a running job looks for a cancellation
}

func defaultConfig() config {
	return config{BatchSize: 1000, Concurrency: 4, TenantBatches: 8, Retries: 5, Backoff: 200 * time.Millisecond, CancelCheck: time.Second}
}

const reportExpiry = 7 * 24 * time.Hour // SigV4 maximum

// limiter caps concurrent core calls per tenant so one big import cannot starve the rest.
type limiter struct {
	n  int
	mu sync.Mutex
	m  map[uuid.UUID]chan struct{}
}

func newLimiter(n int) *limiter { return &limiter{n: n, m: map[uuid.UUID]chan struct{}{}} }

func (l *limiter) acquire(ctx context.Context, tid uuid.UUID) (release func(), err error) {
	l.mu.Lock()
	s := l.m[tid]
	if s == nil {
		s = make(chan struct{}, l.n)
		l.m[tid] = s
	}
	l.mu.Unlock()
	select {
	case s <- struct{}{}:
		return func() { <-s }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

type countReader struct {
	r io.Reader
	n atomic.Int64
}

func (c *countReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n.Add(int64(n))
	return n, err
}

// errorReport streams errors.csv (row number, reason, original row) to MinIO as rows fail.
type errorReport struct {
	mu   sync.Mutex
	cw   *csv.Writer
	pw   *io.PipeWriter
	done chan error
	n    atomic.Int64
}

func newErrorReport(ctx context.Context, st *storage.Client, key string) *errorReport {
	pr, pw := io.Pipe()
	e := &errorReport{cw: csv.NewWriter(pw), pw: pw, done: make(chan error, 1)}
	go func() {
		_, err := st.PutObject(ctx, storage.BucketImports, key, pr, -1,
			minio.PutObjectOptions{ContentType: "text/csv", PartSize: 5 << 20})
		pr.CloseWithError(err) // unblock writers if the upload died
		e.done <- err
	}()
	return e
}

func (e *errorReport) add(line int, reason string, rec []string) {
	e.n.Add(1)
	e.mu.Lock()
	_ = e.cw.Write(append([]string{strconv.Itoa(line), reason}, rec...)) // errors surface in close()
	e.mu.Unlock()
}

func (e *errorReport) header(cols []string) {
	e.mu.Lock()
	_ = e.cw.Write(append([]string{"row_number", "reason"}, cols...))
	e.mu.Unlock()
}

func (e *errorReport) close() error {
	e.cw.Flush()
	err := e.cw.Error()
	e.pw.CloseWithError(err) // nil closes normally
	if uerr := <-e.done; err == nil {
		err = uerr
	}
	return err
}

func (e *errorReport) abort() {
	e.pw.CloseWithError(errors.New("import aborted"))
	<-e.done
}

type mapped struct {
	idx  int
	dest string
}

// plan is the header-resolved mapping shared by every batch of a job.
type plan struct {
	dests     []mapped
	keyIdx    int
	keyName   string
	rowKeyIdx int // relational: column mapped to "row_key", or -1 (row_key defaults to the key value)
}

func newPlan(cols []string, p Params) (*plan, error) {
	pos := map[string]int{}
	for i, c := range cols {
		if _, dup := pos[c]; !dup {
			pos[c] = i
		}
	}
	pl := &plan{keyIdx: -1, rowKeyIdx: -1}
	for col, dest := range p.Mapping {
		i, ok := pos[col]
		if !ok {
			return nil, fmt.Errorf("mapped column %q not found in the file", col)
		}
		pl.dests = append(pl.dests, mapped{i, dest})
		if dest == p.KeyID && pl.keyIdx < 0 {
			pl.keyIdx, pl.keyName = i, col
		}
		if dest == "row_key" {
			pl.rowKeyIdx = i
		}
	}
	if pl.keyIdx < 0 {
		return nil, fmt.Errorf("no column is mapped to key_id %s", p.KeyID)
	}
	return pl, nil
}

type batchRow struct {
	line int
	rec  []string
}

// run is the job handler: it streams the object, validates rows locally, ships batches of
// rows to core with bounded concurrency and streams failures to errors.csv.
func (h *handler) run(ctx context.Context, j *jobs.Job, rep *jobs.Reporter) (jobs.Outcome, error) {
	var p Params
	if err := json.Unmarshal(j.Params, &p); err != nil {
		return jobs.Outcome{}, fmt.Errorf("invalid job params: %w", err)
	}
	obj, err := h.env.Storage.GetObject(ctx, storage.BucketImports, p.ObjectKey, minio.GetObjectOptions{})
	if err != nil {
		return jobs.Outcome{}, err
	}
	defer obj.Close()
	st, err := obj.Stat()
	if err != nil {
		return jobs.Outcome{}, fmt.Errorf("open upload: %w", err)
	}
	size := max(st.Size, 1)

	cnt := &countReader{r: obj}
	cr := newCSVReader(cnt, p.Delimiter, p.Encoding)
	reportKey := fmt.Sprintf("%s/errors/%s.csv", j.TenantID, j.ID)
	report := newErrorReport(ctx, h.env.Storage, reportKey)
	finished := false
	defer func() {
		if !finished {
			report.abort()
		}
	}()

	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(h.cfg.Concurrency)
	var (
		cols      []string
		pl        *plan
		line      int
		batch     = make([]batchRow, 0, h.cfg.BatchSize)
		lastCheck = time.Now()
		cancelled bool
	)
	flush := func() {
		if len(batch) == 0 {
			return
		}
		b := batch
		batch = make([]batchRow, 0, h.cfg.BatchSize)
		rep.SetPercent(min(99, float64(cnt.n.Load())*100/float64(size)))
		if time.Since(lastCheck) >= h.cfg.CancelCheck {
			lastCheck = time.Now()
			if cur, err := h.env.Store.Get(ctx, j.ID); err == nil && cur.Status == jobs.StatusCancelled {
				cancelled = true
				return
			}
		}
		g.Go(func() error { return h.send(gctx, j.TenantID, &p, pl, b, report, rep) })
	}

	for gctx.Err() == nil && !cancelled {
		rec, err := cr.Read()
		if err == io.EOF {
			break
		}
		line++
		var pe *csv.ParseError
		if err != nil && !errors.As(err, &pe) {
			return jobs.Outcome{}, fmt.Errorf("read upload: %w", err)
		}
		if cols == nil {
			if pe != nil {
				return jobs.Outcome{}, fmt.Errorf("malformed header: %w", err)
			}
			cols = rec
			if !p.HasHeader {
				cols = numberedColumns(len(rec))
			}
			if pl, err = newPlan(cols, p); err != nil {
				return jobs.Outcome{}, err
			}
			report.header(cols)
			if p.HasHeader {
				continue
			}
		}
		rep.Add(1, 0, 0)
		switch {
		case pe != nil:
			fail(rep, report, line, "malformed CSV: "+pe.Err.Error(), rec)
		case len(rec) != len(cols):
			fail(rep, report, line, fmt.Sprintf("expected %d columns, got %d", len(cols), len(rec)), rec)
		case strings.TrimSpace(rec[pl.keyIdx]) == "":
			fail(rep, report, line, fmt.Sprintf("empty key value in column %q", pl.keyName), rec)
		default:
			batch = append(batch, batchRow{line, rec})
			if len(batch) == h.cfg.BatchSize {
				flush()
			}
		}
	}
	if gctx.Err() == nil && !cancelled {
		flush()
	}
	if err := g.Wait(); err != nil {
		return jobs.Outcome{}, err
	}
	if cancelled {
		return jobs.Outcome{}, nil // Cancel already set the status; the queue's finish leaves it alone
	}
	if ctx.Err() != nil {
		return jobs.Outcome{}, ctx.Err()
	}
	finished = true
	if err := report.close(); err != nil {
		return jobs.Outcome{}, fmt.Errorf("write errors.csv: %w", err)
	}
	if report.n.Load() == 0 {
		_ = h.env.Storage.RemoveObject(ctx, storage.BucketImports, reportKey, minio.RemoveObjectOptions{})
		return jobs.Outcome{}, nil
	}
	url, err := h.env.Storage.PresignGet(ctx, storage.BucketImports, reportKey, reportExpiry)
	return jobs.Outcome{ErrorReportURL: url}, err
}

func fail(rep *jobs.Reporter, report *errorReport, line int, reason string, rec []string) {
	rep.Add(0, 0, 1)
	report.add(line, reason, rec)
}

type coreResponse struct {
	Results []struct { // batch-upsert
		Index int `json:"index"`
		Error *struct {
			Code    int     `json:"code"`
			Text    string  `json:"text"`
			FieldID *string `json:"field_id"`
		} `json:"error"`
	} `json:"results"`
	Errors []struct { // members and relational rows
		Index int    `json:"index"`
		Code  int    `json:"code"`
		Text  string `json:"text"`
	} `json:"errors"`
}

// send posts one batch to core and accounts for its rows. Only a batch core keeps rejecting
// with 5xx aborts the job; a 4xx or per-item error fails just those rows.
func (h *handler) send(ctx context.Context, tid uuid.UUID, p *Params, pl *plan, rows []batchRow, report *errorReport, rep *jobs.Reporter) error {
	release, err := h.lim.acquire(ctx, tid)
	if err != nil {
		return err
	}
	defer release()

	path, body := h.request(tid, p, pl, rows)
	var resp coreResponse
	err = h.post(ctx, path, body, &resp)
	var se *coreclient.StatusError
	if errors.As(err, &se) && !se.Retryable() {
		for _, r := range rows {
			fail(rep, report, r.line, fmt.Sprintf("core rejected the batch: status %d: %s", se.Code, se.Body), r.rec)
		}
		return nil
	}
	if err != nil {
		return err
	}
	reasons := map[int]string{}
	for _, r := range resp.Results {
		if r.Error != nil {
			reasons[r.Index] = fmt.Sprintf("%d: %s", r.Error.Code, r.Error.Text)
			if r.Error.FieldID != nil {
				reasons[r.Index] += " (field " + *r.Error.FieldID + ")"
			}
		}
	}
	for _, e := range resp.Errors {
		reasons[e.Index] = fmt.Sprintf("%d: %s", e.Code, e.Text)
	}
	for i, r := range rows {
		if reason, bad := reasons[i]; bad {
			fail(rep, report, r.line, reason, r.rec)
		}
	}
	rep.Add(0, int64(len(rows)-len(reasons)), 0)
	return nil
}

func (h *handler) request(tid uuid.UUID, p *Params, pl *plan, rows []batchRow) (string, any) {
	kind, id, _ := strings.Cut(p.Target, ":")
	switch kind {
	case "list":
		keys := make([]string, len(rows))
		for i, r := range rows {
			keys[i] = r.rec[pl.keyIdx]
		}
		return "/internal/v1/lists/" + id + "/members", map[string]any{"tenant_id": tid, "key_id": p.KeyID, "key_values": keys}
	case "relational":
		out := make([]map[string]any, len(rows))
		for i, r := range rows {
			data := map[string]any{}
			for _, d := range pl.dests {
				if d.dest != p.KeyID && d.dest != "row_key" && r.rec[d.idx] != "" {
					data[d.dest] = r.rec[d.idx]
				}
			}
			key := r.rec[pl.keyIdx]
			rowKey := key // ponytail: without a row_key column each contact has one row; map a column to "row_key" for more
			if pl.rowKeyIdx >= 0 && r.rec[pl.rowKeyIdx] != "" {
				rowKey = r.rec[pl.rowKeyIdx]
			}
			out[i] = map[string]any{"key_value": key, "row_key": rowKey, "data": data}
		}
		return "/internal/v1/relational/" + id + "/rows", map[string]any{"tenant_id": tid, "key_id": p.KeyID, "rows": out}
	}
	contacts := make([]map[string]string, len(rows))
	for i, r := range rows {
		c := make(map[string]string, len(pl.dests))
		for _, d := range pl.dests {
			if v := r.rec[d.idx]; v != "" {
				c[d.dest] = v
			}
		}
		contacts[i] = c
	}
	return "/internal/v1/contacts/batch-upsert", map[string]any{
		"tenant_id": tid, "key_id": p.KeyID, "mode": p.Mode, "source": "import", "contacts": contacts,
	}
}

// post retries 5xx, 429 and network failures with exponential backoff.
func (h *handler) post(ctx context.Context, path string, body any, out any) error {
	wait := h.cfg.Backoff
	for attempt := 0; ; attempt++ {
		err := h.env.Core.Post(ctx, path, body, out)
		if err == nil || ctx.Err() != nil {
			return err
		}
		var se *coreclient.StatusError
		if (errors.As(err, &se) && !se.Retryable()) || attempt >= h.cfg.Retries {
			return err
		}
		select {
		case <-time.After(wait):
			wait *= 2
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}
