package imports

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/open-emarsys/oe/libs/go/oe/auth"
	"github.com/open-emarsys/oe/libs/go/oe/pg"
	"github.com/open-emarsys/oe/libs/go/oe/tenant"
	"github.com/open-emarsys/oe/services/importer/internal/coreclient"
	"github.com/open-emarsys/oe/services/importer/internal/jobs"
	"github.com/open-emarsys/oe/services/importer/internal/storage"
	"github.com/open-emarsys/oe/services/importer/migrations"
)

func TestSniff(t *testing.T) {
	d, e := sniff([]byte("nombre;email\nJosé;a@b.c\n"), false)
	if d != ';' || e != utf8Name {
		t.Fatalf("utf-8 semicolon: %q %s", d, e)
	}
	d, e = sniff([]byte("nombre\temail\nJos\xe9\ta@b.c\n"), false)
	if d != '\t' || e != latin1Name {
		t.Fatalf("latin-1 tab: %q %s", d, e)
	}
	// a sample cut inside "é" is still UTF-8
	full := []byte("a,b\nJosé,x")
	if _, e = sniff(full[:len(full)-len("x")-1], true); e != utf8Name {
		t.Fatalf("truncated rune: %s", e)
	}
	if d, _ = sniff([]byte("\"a,b;c\",d|e\n"), false); d != ',' && d != '|' {
		t.Fatalf("quoted delimiters counted: %q", d)
	}
}

// ---- fixtures ----

func startPostgres(t *testing.T) *jobs.Store {
	t.Helper()
	ctx := context.Background()
	ctr, err := tcpostgres.Run(ctx, "postgres:17-alpine",
		tcpostgres.WithDatabase("oe"), tcpostgres.WithUsername("admin"), tcpostgres.WithPassword("admin"),
		tcpostgres.BasicWaitStrategies())
	if err != nil {
		t.Skipf("no docker for postgres container: %v", err)
	}
	t.Cleanup(func() { _ = testcontainers.TerminateContainer(ctr) })
	adminDSN, err := ctr.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	admin, err := pgxpool.New(ctx, adminDSN)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	if _, err := admin.Exec(ctx, `CREATE ROLE importer LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'imp';
		CREATE SCHEMA importer AUTHORIZATION importer; GRANT CREATE ON DATABASE oe TO importer`); err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(adminDSN)
	u.User = url.UserPassword("importer", "imp")
	pool, err := pg.NewPool(ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := pg.Migrate(ctx, pool, "importer", migrations.FS); err != nil {
		t.Fatal(err)
	}
	return jobs.NewStore(pool)
}

func startMinio(t *testing.T) *storage.Client {
	t.Helper()
	ctx := context.Background()
	ctr, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image:        "quay.io/minio/minio:latest",
			Cmd:          []string{"server", "/data"},
			Env:          map[string]string{"MINIO_ROOT_USER": "oe_minio", "MINIO_ROOT_PASSWORD": "oe_minio_secret"},
			ExposedPorts: []string{"9000/tcp"},
			WaitingFor:   wait.ForHTTP("/minio/health/ready").WithPort("9000/tcp"),
		},
		Started: true,
	})
	if err != nil {
		t.Skipf("no docker for minio container: %v", err)
	}
	t.Cleanup(func() { _ = testcontainers.TerminateContainer(ctr) })
	ep, err := ctr.PortEndpoint(ctx, "9000/tcp", "")
	if err != nil {
		t.Fatal(err)
	}
	st, err := storage.New(storage.Config{Endpoint: ep, AccessKey: "oe_minio", SecretKey: "oe_minio_secret"})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.MakeBucket(ctx, storage.BucketImports, minio.MakeBucketOptions{}); err != nil {
		t.Fatal(err)
	}
	return st
}

// fakeCore validates the C4 contract on batch-upsert, members and relational rows. Emails
// without "@" come back as per-item errors; the 3rd call answers 503 once to exercise retries.
type fakeCore struct {
	*httptest.Server
	tenant  uuid.UUID
	calls   atomic.Int64
	rows    atomic.Int64
	delay   time.Duration
	problem atomic.Value // first contract violation
}

func newFakeCore(t *testing.T, tid uuid.UUID, delay time.Duration) *fakeCore {
	f := &fakeCore{tenant: tid, delay: delay}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /internal/v1/service-token", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"access_token":"svc","expires_in":3600}`))
	})
	violate := func(format string, a ...any) { f.problem.CompareAndSwap(nil, fmt.Sprintf(format, a...)) }
	mux.HandleFunc("POST /internal/v1/contacts/batch-upsert", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer svc" {
			violate("missing service token")
		}
		var in struct {
			TenantID string              `json:"tenant_id"`
			KeyID    string              `json:"key_id"`
			Mode     string              `json:"mode"`
			Contacts []map[string]string `json:"contacts"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			violate("bad json: %v", err)
			http.Error(w, "bad", 400)
			return
		}
		if in.TenantID != f.tenant.String() || in.KeyID != "3" || in.Mode != "upsert" ||
			len(in.Contacts) < 1 || len(in.Contacts) > 1000 {
			violate("contract: tenant=%s key=%s mode=%s n=%d", in.TenantID, in.KeyID, in.Mode, len(in.Contacts))
			http.Error(w, "bad", 400)
			return
		}
		if f.calls.Add(1) == 3 {
			http.Error(w, "boom", http.StatusServiceUnavailable)
			return
		}
		if f.delay > 0 {
			time.Sleep(f.delay)
		}
		type item struct {
			Index int            `json:"index"`
			ID    *string        `json:"id"`
			New   bool           `json:"created"`
			Error map[string]any `json:"error,omitempty"`
		}
		res := make([]item, len(in.Contacts))
		for i, c := range in.Contacts {
			if _, ok := c["3"]; !ok {
				violate("item %d lacks key field", i)
			}
			if strings.Contains(c["3"], "@") {
				id := uuid.NewString()
				res[i] = item{Index: i, ID: &id, New: true}
				f.rows.Add(1)
			} else {
				res[i] = item{Index: i, Error: map[string]any{"code": 2010, "text": "invalid email", "field_id": "3"}}
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"results": res})
	})
	f.Server = httptest.NewServer(mux)
	t.Cleanup(f.Close)
	return f
}

type rig struct {
	h     *handler
	store *jobs.Store
	st    *storage.Client
	ctx   context.Context // carries the tenant
	tid   uuid.UUID
	core  *fakeCore
}

func newRig(t *testing.T, coreDelay time.Duration) *rig {
	store := startPostgres(t)
	st := startMinio(t)
	tid := uuid.New()
	core := newFakeCore(t, tid, coreDelay)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	q := jobs.NewQueue(store, log, jobs.Options{Workers: 2, Poll: 20 * time.Millisecond, ProgressEvery: 100 * time.Millisecond})
	env := &jobs.Env{Store: store, Queue: q, Storage: st,
		Core: coreclient.New(core.URL, auth.NewServiceTokenSource(core.URL, "importer", "s"))}
	cfg := defaultConfig()
	cfg.Backoff, cfg.CancelCheck = 10*time.Millisecond, 50*time.Millisecond
	h := &handler{env: env, cfg: cfg, lim: newLimiter(cfg.TenantBatches)}
	q.Handle(Kind, h.run)
	wctx, stop := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { q.Run(wctx); close(done) }()
	t.Cleanup(func() { stop(); <-done })
	return &rig{h: h, store: store, st: st, ctx: tenant.WithTenant(context.Background(), tid), tid: tid, core: core}
}

func (r *rig) wait(t *testing.T, id uuid.UUID, d time.Duration) *jobs.Job {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		j, err := r.store.Get(r.ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		if j.Status != jobs.StatusQueued && j.Status != jobs.StatusRunning {
			return j
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("job did not finish in time")
	return nil
}

func (r *rig) put(t *testing.T, key string, body io.Reader) {
	t.Helper()
	if _, err := r.st.PutObject(context.Background(), storage.BucketImports, key, body, -1,
		minio.PutObjectOptions{PartSize: 16 << 20}); err != nil {
		t.Fatal(err)
	}
}

func params(key string) Params {
	return Params{ObjectKey: key, Delimiter: ",", Encoding: utf8Name, HasHeader: true,
		Mapping: map[string]string{"email": "3", "name": "1"}, KeyID: "3", Mode: "upsert", Target: "contacts"}
}

// ---- the acceptance test ----

// 1 M rows with 1,000 invalid ones (500 rejected locally for an empty key, 500 by core): the job
// finishes alone, rows_ok is 999,000, errors.csv lists all 1,000 with a reason, and the heap
// stays far below 150 MB.
func TestImportMillionRows(t *testing.T) {
	if testing.Short() {
		t.Skip("1M-row import")
	}
	r := newRig(t, 0)
	const total, badEvery = 1_000_000, 1000

	pr, pw := io.Pipe()
	go func() {
		w := csv.NewWriter(pw)
		_ = w.Write([]string{"email", "name"})
		for i := 1; i <= total; i++ {
			email := fmt.Sprintf("user%d@example.com", i)
			if i%badEvery == 0 {
				if (i/badEvery)%2 == 0 {
					email = ""
				} else {
					email = "not-an-email-" + strconv.Itoa(i)
				}
			}
			_ = w.Write([]string{email, "Name " + strconv.Itoa(i)})
		}
		w.Flush()
		pw.CloseWithError(w.Error())
	}()
	key := newObjectKey(r.tid, "big.csv")
	r.put(t, key, pr)

	runtime.GC()
	var peak atomic.Uint64
	stop := make(chan struct{})
	sampled := make(chan struct{})
	go func() {
		defer close(sampled)
		var ms runtime.MemStats
		for {
			runtime.ReadMemStats(&ms)
			if ms.HeapInuse > peak.Load() {
				peak.Store(ms.HeapInuse)
			}
			select {
			case <-stop:
				return
			case <-time.After(20 * time.Millisecond):
			}
		}
	}()

	id, err := r.store.Enqueue(r.ctx, Kind, params(key), "tester")
	if err != nil {
		t.Fatal(err)
	}
	j := r.wait(t, id, 5*time.Minute)
	close(stop)
	<-sampled

	if j.Status != jobs.StatusSucceeded {
		t.Fatalf("status %s: %v", j.Status, j.Error)
	}
	if p := j.Progress; p.RowsRead != total || p.RowsOK != total-1000 || p.RowsFailed != 1000 {
		t.Fatalf("progress %+v", p)
	}
	if v := r.core.problem.Load(); v != nil {
		t.Fatalf("core saw a contract violation: %v", v)
	}
	if got := r.core.rows.Load(); got != total-1000 {
		t.Fatalf("core accepted %d rows", got)
	}
	t.Logf("peak heap in use: %d MB", peak.Load()>>20)
	if peak.Load() > 150<<20 {
		t.Fatalf("heap peaked at %d MB", peak.Load()>>20)
	}

	if j.ErrorReportURL == nil {
		t.Fatal("no error_report_url")
	}
	resp, err := http.Get(*j.ErrorReportURL)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	rows, err := csv.NewReader(resp.Body).ReadAll()
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("report: %d %v", resp.StatusCode, err)
	}
	if rows[0][0] != "row_number" || len(rows) != 1001 {
		t.Fatalf("report has %d rows, header %v", len(rows), rows[0])
	}
	local, remote := 0, 0
	seen := map[string]bool{}
	for _, row := range rows[1:] {
		n, _ := strconv.Atoi(row[0])
		if n%badEvery != 1 { // file line = data row + 1 (header)
			t.Fatalf("unexpected failing line %s", row[0])
		}
		seen[row[0]] = true
		switch {
		case strings.HasPrefix(row[1], "empty key value") && row[2] == "":
			local++
		case strings.HasPrefix(row[1], "2010: invalid email") && strings.HasPrefix(row[2], "not-an-email-"):
			remote++
		default:
			t.Fatalf("odd report row %v", row)
		}
	}
	if local != 500 || remote != 500 || len(seen) != 1000 {
		t.Fatalf("local %d remote %d distinct %d", local, remote, len(seen))
	}
}

// ---- HTTP flow and cancellation ----

func TestImportHTTPFlow(t *testing.T) {
	r := newRig(t, 0)
	do := func(h http.HandlerFunc, path, id string, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", path, strings.NewReader(body)).WithContext(r.ctx)
		if id != "" {
			req.SetPathValue("id", id)
		}
		rec := httptest.NewRecorder()
		h(rec, req)
		return rec
	}

	rec := do(r.h.uploadURL, "/admin/v1/imports/upload-url", "", `{"filename":"../people.csv"}`)
	if rec.Code != 201 {
		t.Fatalf("upload-url: %d %s", rec.Code, rec.Body)
	}
	var up struct {
		URL       string `json:"url"`
		ObjectKey string `json:"object_key"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &up)
	if !strings.HasPrefix(up.ObjectKey, r.tid.String()+"/uploads/") || strings.Contains(up.ObjectKey, "..") {
		t.Fatalf("object key %q", up.ObjectKey)
	}

	// Latin-1, semicolon delimited, uploaded through the presigned URL.
	latin1 := "email;nombre\nana@x.com;Jos\xe9\nbad;Luc\xeda\nluz@x.com;Ana\n"
	req, _ := http.NewRequest(http.MethodPut, up.URL, strings.NewReader(latin1))
	if resp, err := http.DefaultClient.Do(req); err != nil || resp.StatusCode != 200 {
		t.Fatalf("presigned put: %v %v", resp, err)
	}

	rec = do(r.h.create, "/admin/v1/imports", "", fmt.Sprintf(`{"object_key":%q}`, up.ObjectKey))
	var draftJob struct{ ID, Status string }
	_ = json.Unmarshal(rec.Body.Bytes(), &draftJob)
	if rec.Code != 201 || draftJob.Status != "draft" {
		t.Fatalf("create: %d %s", rec.Code, rec.Body)
	}
	if rec = do(r.h.create, "/admin/v1/imports", "", fmt.Sprintf(`{"object_key":"%s/uploads/x/y.csv"}`, uuid.New())); rec.Code != 400 {
		t.Fatalf("foreign object key must be 400, got %d", rec.Code)
	}

	rec = do(r.h.preview, "/x", draftJob.ID, "")
	var pv struct {
		Delimiter, Encoding string
		Columns             []string
		Rows                [][]string
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &pv)
	if rec.Code != 200 || pv.Delimiter != ";" || pv.Encoding != latin1Name || len(pv.Rows) != 3 || pv.Rows[0][1] != "José" || pv.Columns[1] != "nombre" {
		t.Fatalf("preview: %d %s", rec.Code, rec.Body)
	}

	rec = do(r.h.start, "/x", draftJob.ID, `{"mapping":{"email":"3","nombre":"1"},"key_id":"3","mode":"upsert","target":"contacts"}`)
	var started jobs.Job
	_ = json.Unmarshal(rec.Body.Bytes(), &started)
	if rec.Code != 202 {
		t.Fatalf("start: %d %s", rec.Code, rec.Body)
	}
	j := r.wait(t, started.ID, time.Minute)
	if j.Status != jobs.StatusSucceeded || j.Progress.RowsRead != 3 || j.Progress.RowsOK != 2 || j.Progress.RowsFailed != 1 || j.ErrorReportURL == nil {
		t.Fatalf("job %+v err=%v", j, j.Error)
	}
	if rec = do(r.h.start, "/x", draftJob.ID, `{}`); rec.Code != 409 {
		t.Fatalf("second start must be 409, got %d", rec.Code)
	}

	// Public multipart endpoint.
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	_ = mw.WriteField("mapping", `{"email":"3","name":"1"}`)
	_ = mw.WriteField("key_id", "3")
	_ = mw.WriteField("mode", "upsert")
	_ = mw.WriteField("target", "contacts")
	fw, _ := mw.CreateFormFile("file", "c.csv")
	_, _ = fw.Write([]byte("email,name\na@x.com,A\nb@x.com,B\n"))
	_ = mw.Close()
	req2 := httptest.NewRequest("POST", "/api/v3/import", &buf).WithContext(r.ctx)
	req2.Header.Set("Content-Type", mw.FormDataContentType())
	rec = httptest.NewRecorder()
	r.h.publicImport(rec, req2)
	var env struct {
		ReplyCode int
		Data      struct {
			JobID string `json:"job_id"`
		}
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &env)
	if rec.Code != 202 || env.ReplyCode != 0 {
		t.Fatalf("public import: %d %s", rec.Code, rec.Body)
	}
	id, _ := uuid.Parse(env.Data.JobID)
	if j := r.wait(t, id, time.Minute); j.Status != jobs.StatusSucceeded || j.Progress.RowsOK != 2 || j.ErrorReportURL != nil {
		t.Fatalf("public job %+v", j)
	}
}

func TestImportCancel(t *testing.T) {
	r := newRig(t, 80*time.Millisecond)
	var b strings.Builder
	b.WriteString("email,name\n")
	for i := 0; i < 60_000; i++ {
		fmt.Fprintf(&b, "u%d@x.com,N\n", i)
	}
	key := newObjectKey(r.tid, "slow.csv")
	r.put(t, key, strings.NewReader(b.String()))
	id, err := r.store.Enqueue(r.ctx, Kind, params(key), "tester")
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(600 * time.Millisecond)
	if _, err := r.store.Cancel(r.ctx, id); err != nil {
		t.Fatal(err)
	}
	time.Sleep(1500 * time.Millisecond) // the handler notices and returns; finish must not overwrite
	j, _ := r.store.Get(r.ctx, id)
	if j.Status != jobs.StatusCancelled {
		t.Fatalf("status %s", j.Status)
	}
	at := r.core.rows.Load()
	time.Sleep(500 * time.Millisecond)
	if r.core.rows.Load() != at || at >= 60_000 {
		t.Fatalf("job kept sending after cancel: %d -> %d", at, r.core.rows.Load())
	}
	if _, err := r.store.Cancel(r.ctx, id); err != jobs.ErrFinished {
		t.Fatalf("second cancel: %v", err)
	}
}
