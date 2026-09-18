package exports

import (
	"bufio"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
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
	natstest "github.com/nats-io/nats-server/v2/test"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/open-emarsys/oe/libs/go/oe/auth"
	"github.com/open-emarsys/oe/libs/go/oe/natsx"
	"github.com/open-emarsys/oe/libs/go/oe/pg"
	"github.com/open-emarsys/oe/libs/go/oe/tenant"
	"github.com/open-emarsys/oe/services/importer/internal/jobs"
	"github.com/open-emarsys/oe/services/importer/internal/storage"
	"github.com/open-emarsys/oe/services/importer/migrations"
)

func TestRender(t *testing.T) {
	meta := fieldMeta{DefaultLocale: "pt", Fields: []field{
		{FieldID: 7, APIName: "plan", Type: "single_choice", Choices: []choice{{1, map[string]string{"es": "Pro", "pt": "Profissional"}}}},
		{FieldID: 8, APIName: "tags", Type: "multi_choice", Choices: []choice{{1, map[string]string{"pt": "A"}}, {2, map[string]string{"es": "solo es"}}}},
		{FieldID: 3, APIName: "email", Type: "text"},
	}}
	cols, err := columns(meta, []int{3, 7, 8})
	if err != nil {
		t.Fatal(err)
	}
	in := `{"id":"x","fields":{"3":"a,\"b\"@x.com","7":1,"8":[1,2,9]}}` + "\n" + `{"id":"y","fields":{}}` + "\n"
	var out strings.Builder
	if err := writeCSV(&out, strings.NewReader(in), cols, &jobs.Reporter{}); err != nil {
		t.Fatal(err)
	}
	want := "email,plan,tags\n\"a,\"\"b\"\"@x.com\",Profissional,A; 2; 9\n,,\n"
	if out.String() != want {
		t.Fatalf("got %q, want %q", out.String(), want)
	}
	if err := writeCSV(io.Discard, strings.NewReader(`{"id":"x","fields":{}}`), cols, &jobs.Reporter{}); err == nil {
		t.Fatal("a stream without final newline must fail")
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
	if err := st.MakeBucket(ctx, storage.BucketExports, minio.MakeBucketOptions{}); err != nil {
		t.Fatal(err)
	}
	return st
}

// startNats runs an embedded JetStream server with the SYSTEM stream and returns a client
// for the importer and a subscription that sees every published system event.
func startNats(t *testing.T) (*natsx.Client, *nats.Subscription) {
	t.Helper()
	opts := natstest.DefaultTestOptions
	opts.Port = -1
	opts.JetStream = true
	opts.StoreDir = t.TempDir()
	srv := natstest.RunServer(&opts)
	t.Cleanup(srv.Shutdown)
	nc, err := nats.Connect(srv.ClientURL())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(nc.Close)
	js, err := jetstream.New(nc)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := js.CreateStream(ctx, jetstream.StreamConfig{Name: "SYSTEM", Subjects: []string{"oe.system.>"}, Storage: jetstream.MemoryStorage}); err != nil {
		t.Fatal(err)
	}
	sub, err := nc.SubscribeSync("oe.system.job.completed.>")
	if err != nil {
		t.Fatal(err)
	}
	ev, err := natsx.New(nc, "importer")
	if err != nil {
		t.Fatal(err)
	}
	return ev, sub
}

const total = 1_000_000

// fakeCore serves the two C4 endpoints exports use. The stream generates `total` contacts on
// the fly: field 3 is the email, field 7 a single_choice (option 1 or 2).
type fakeCore struct {
	*httptest.Server
	tenant  uuid.UUID
	problem atomic.Value // first contract violation
}

func newFakeCore(t *testing.T, tid uuid.UUID) *fakeCore {
	f := &fakeCore{tenant: tid}
	violate := func(format string, a ...any) { f.problem.CompareAndSwap(nil, fmt.Sprintf(format, a...)) }
	mux := http.NewServeMux()
	mux.HandleFunc("POST /internal/v1/service-token", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"access_token":"svc","expires_in":3600}`))
	})
	mux.HandleFunc("GET /internal/v1/fields", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer svc" || r.URL.Query().Get("tenant_id") != tid.String() {
			violate("fields: auth=%q tenant=%q", r.Header.Get("Authorization"), r.URL.Query().Get("tenant_id"))
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		_, _ = w.Write([]byte(`{"default_locale":"pt","fields":[
			{"field_id":3,"api_name":"email","type":"text","choices":[]},
			{"field_id":7,"api_name":"plan","type":"single_choice","choices":[
				{"id":1,"labels":{"es":"Profesional","pt":"Profissional","en":"Pro"}},
				{"id":2,"labels":{"es":"Gratis","pt":"Grátis","en":"Free"}}]}]}`))
	})
	mux.HandleFunc("GET /internal/v1/contacts/stream", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if r.Header.Get("Authorization") != "Bearer svc" || q.Get("tenant_id") != tid.String() || q.Get("fields") != "3,7" || q.Get("list_id") != "" {
			violate("stream: auth=%q query=%v", r.Header.Get("Authorization"), q)
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/x-ndjson")
		bw := bufio.NewWriterSize(w, 64<<10)
		for i := 1; i <= total; i++ {
			fmt.Fprintf(bw, `{"id":"%s","fields":{"3":"user%d@example.com","7":%d}}`+"\n", uuid.NewString(), i, i%2+1)
		}
		_ = bw.Flush()
	})
	f.Server = httptest.NewServer(mux)
	t.Cleanup(f.Close)
	return f
}

// ---- the acceptance test ----

// 1 M contacts stream from core to MinIO with the heap far below 150 MB; the presigned URL
// downloads the whole CSV (api_name header, option labels in the tenant locale), stops working
// once it expires, and system.job.completed carries the URL.
func TestExportMillionContacts(t *testing.T) {
	if testing.Short() {
		t.Skip("1M-contact export")
	}
	store, st := startPostgres(t), startMinio(t)
	ev, sub := startNats(t)
	tid := uuid.New()
	core := newFakeCore(t, tid)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	q := jobs.NewQueue(store, log, jobs.Options{Workers: 1, Poll: 20 * time.Millisecond, ProgressEvery: 100 * time.Millisecond})
	tokens := auth.NewServiceTokenSource(core.URL, "importer", "s")
	env := &jobs.Env{Store: store, Queue: q, Storage: st, CoreURL: core.URL, CoreTokens: tokens, Events: ev}
	const ttl = 3 * time.Second
	h := &handler{env: env, core: newCoreAPI(core.URL, tokens), ttl: ttl}
	q.Handle(Kind, h.run)
	wctx, stop := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { q.Run(wctx); close(done) }()
	t.Cleanup(func() { stop(); <-done })
	ctx := tenant.WithTenant(context.Background(), tid)

	runtime.GC()
	var peak atomic.Uint64
	stopSample := make(chan struct{})
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
			case <-stopSample:
				return
			case <-time.After(20 * time.Millisecond):
			}
		}
	}()

	id, err := store.Enqueue(ctx, Kind, Params{Fields: []int{3, 7}, Scope: "all", Format: "csv"}, "tester")
	if err != nil {
		t.Fatal(err)
	}
	var j *jobs.Job
	for deadline := time.Now().Add(5 * time.Minute); ; time.Sleep(50 * time.Millisecond) {
		if j, err = store.Get(ctx, id); err != nil {
			t.Fatal(err)
		}
		if j.Status != jobs.StatusQueued && j.Status != jobs.StatusRunning {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("export did not finish in time")
		}
	}
	finished := time.Now()
	close(stopSample)
	<-sampled

	if j.Status != jobs.StatusSucceeded || j.ResultURL == nil {
		t.Fatalf("status %s error %v", j.Status, j.Error)
	}
	if v := core.problem.Load(); v != nil {
		t.Fatalf("core saw a contract violation: %v", v)
	}
	if j.Progress.RowsRead != total {
		t.Fatalf("progress %+v", j.Progress)
	}
	t.Logf("peak heap in use: %d MB", peak.Load()>>20)
	if peak.Load() > 150<<20 {
		t.Fatalf("heap peaked at %d MB", peak.Load()>>20)
	}

	// the URL downloads the complete CSV
	resp, err := http.Get(*j.ResultURL)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("download: %d", resp.StatusCode)
	}
	cr := csv.NewReader(bufio.NewReaderSize(resp.Body, 64<<10))
	cr.ReuseRecord = true
	head, err := cr.Read()
	if err != nil || strings.Join(head, ",") != "email,plan" {
		t.Fatalf("header %v (%v)", head, err)
	}
	n := 0
	for {
		rec, err := cr.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("row %d: %v", n+1, err)
		}
		n++
		wantPlan := map[int]string{0: "Profissional", 1: "Grátis"}[n%2] // option i%2+1: 1 -> Profissional, 2 -> Grátis
		if rec[0] != "user"+strconv.Itoa(n)+"@example.com" || rec[1] != wantPlan {
			t.Fatalf("row %d = %v", n, rec)
		}
	}
	if n != total {
		t.Fatalf("csv has %d rows, want %d", n, total)
	}

	// once expired the URL is refused
	time.Sleep(time.Until(finished.Add(ttl + 2*time.Second)))
	late, err := http.Get(*j.ResultURL)
	if err != nil {
		t.Fatal(err)
	}
	late.Body.Close()
	if late.StatusCode != http.StatusForbidden {
		t.Fatalf("expired URL answered %d", late.StatusCode)
	}

	// and the console notice was published
	msg, err := sub.NextMsg(10 * time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var got natsx.Envelope
	if err := json.Unmarshal(msg.Data, &got); err != nil {
		t.Fatal(err)
	}
	var data struct {
		JobID     string `json:"job_id"`
		Kind      string `json:"kind"`
		Status    string `json:"status"`
		ResultURL string `json:"result_url"`
	}
	if err := json.Unmarshal(got.Data, &data); err != nil {
		t.Fatal(err)
	}
	if got.Type != "system.job.completed" || got.TenantID != tid || data.JobID != id.String() ||
		data.Kind != "export" || data.Status != "succeeded" || data.ResultURL != *j.ResultURL {
		t.Fatalf("event %+v data %+v", got, data)
	}
}
