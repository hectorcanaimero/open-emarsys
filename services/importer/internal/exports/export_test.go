package exports

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/open-emarsys/oe/libs/go/oe/auth"
	"github.com/open-emarsys/oe/libs/go/oe/tenant"
	"github.com/open-emarsys/oe/services/importer/internal/coreclient"
	"github.com/open-emarsys/oe/services/importer/internal/jobs"
	"github.com/open-emarsys/oe/services/importer/internal/storage"
)

const rowsTotal = 1_000_000

type recorder struct {
	mu   sync.Mutex
	seen []map[string]any
}

func (r *recorder) Publish(_ context.Context, typ string, _ uuid.UUID, _ *uuid.UUID, data any) (string, error) {
	raw, _ := json.Marshal(data)
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	m["_type"] = typ
	r.mu.Lock()
	r.seen = append(r.seen, m)
	r.mu.Unlock()
	return "id", nil
}

func TestCell(t *testing.T) {
	choice := column{Type: "single_choice", Choices: map[string]string{"7": "Sí"}}
	for _, tc := range []struct {
		col  column
		raw  string
		want string
	}{
		{column{}, `null`, ""},
		{column{}, ``, ""},
		{column{}, `"ana"`, "ana"},
		{column{}, `"=SUM(A1)"`, "'=SUM(A1)"},
		{column{}, `12.50`, "12.50"},
		{column{}, `true`, "true"},
		{choice, `7`, "Sí"},
		{choice, `[7,8]`, "Sí;8"},
	} {
		if got := cell(tc.col, json.RawMessage(tc.raw)); got != tc.want {
			t.Errorf("cell(%s) = %q, want %q", tc.raw, got, tc.want)
		}
	}
}

func TestExport1M(t *testing.T) {
	ctx := context.Background()
	ctr, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image:        "quay.io/minio/minio:latest",
			Cmd:          []string{"server", "/data"},
			ExposedPorts: []string{"9000/tcp"},
			Env:          map[string]string{"MINIO_ROOT_USER": "oe_minio", "MINIO_ROOT_PASSWORD": "oe_minio_secret"},
			Tmpfs:        map[string]string{"/data": "rw,size=512m"}, // MinIO refuses writes on a nearly full host disk
			WaitingFor:   wait.ForHTTP("/minio/health/live").WithPort("9000/tcp"),
		},
		Started: true,
	})
	if err != nil {
		t.Skipf("no docker for minio container: %v", err)
	}
	t.Cleanup(func() { _ = testcontainers.TerminateContainer(ctr) })
	endpoint, err := ctr.PortEndpoint(ctx, "9000/tcp", "")
	if err != nil {
		t.Fatal(err)
	}
	st, err := storage.New(storage.Config{Endpoint: endpoint, AccessKey: "oe_minio", SecretKey: "oe_minio_secret"})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.MakeBucket(ctx, storage.BucketExports, minio.MakeBucketOptions{}); err != nil {
		t.Fatal(err)
	}

	tenantID, jobID := uuid.New(), uuid.New()
	core := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/internal/v1/service-token":
			_, _ = io.WriteString(w, `{"access_token":"svc","expires_in":3600}`)
		case "/internal/v1/contacts/stream":
			if r.Header.Get("Authorization") != "Bearer svc" || r.URL.Query().Get("tenant_id") != tenantID.String() ||
				r.URL.Query().Get("fields") != "3,1001,1002" {
				http.Error(w, "bad request", http.StatusBadRequest)
				return
			}
			bw := bufio.NewWriterSize(w, 64<<10)
			for i := 0; i < rowsTotal; i++ {
				fmt.Fprintf(bw, `{"id":"c%d","fields":{"3":"u%d@example.com","1001":%d,"1002":[1,2]}}`+"\n", i, i, i%2+1)
			}
			_ = bw.Flush()
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(core.Close)

	pub := &recorder{}
	Events = pub
	t.Cleanup(func() { Events = nil })
	env := &jobs.Env{Storage: st, Core: coreclient.New(core.URL, auth.NewServiceTokenSource(core.URL, "importer", "s"))}
	cols := []column{
		{ID: 3, APIName: "email", Type: "text"},
		{ID: 1001, APIName: "plan", Type: "single_choice", Choices: map[string]string{"1": "Básico", "2": "Pro"}},
		{ID: 1002, APIName: "tags", Type: "multi_choice", Choices: map[string]string{"1": "a", "2": "b"}},
	}
	rawParams, _ := json.Marshal(map[string]any{"scope": "all", "columns": cols})
	job := &jobs.Job{ID: jobID, TenantID: tenantID, Kind: kind, Params: rawParams, CreatedBy: "user-1"}

	// Peak heap sampled while the export runs; the 1M-row CSV is ~50 MB, so buffering it would show.
	var peak uint64
	stop := make(chan struct{})
	sampled := make(chan struct{})
	go func() {
		defer close(sampled)
		var ms runtime.MemStats
		for {
			runtime.ReadMemStats(&ms)
			peak = max(peak, ms.HeapInuse)
			select {
			case <-stop:
				return
			case <-time.After(20 * time.Millisecond):
			}
		}
	}()
	out, err := newHandler(env, time.Second)(tenant.WithTenant(ctx, tenantID), job, &jobs.Reporter{})
	close(stop)
	<-sampled
	if err != nil {
		t.Fatal(err)
	}
	if peak > 150<<20 {
		t.Errorf("peak heap %d MB, want < 150 MB", peak>>20)
	}

	// The presigned URL serves the whole CSV.
	resp, err := http.Get(out.ResultURL)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("download status %d", resp.StatusCode)
	}
	sc := bufio.NewScanner(resp.Body)
	var n int
	var head, first, last string
	for sc.Scan() {
		if n == 0 {
			head = sc.Text()
		}
		if n == 1 {
			first = sc.Text()
		}
		last = sc.Text()
		n++
	}
	if sc.Err() != nil {
		t.Fatal(sc.Err())
	}
	if n != rowsTotal+1 {
		t.Errorf("csv lines = %d, want %d", n, rowsTotal+1)
	}
	if head != "email,plan,tags" {
		t.Errorf("header %q", head)
	}
	if first != "u0@example.com,Básico,a;b" || !strings.HasPrefix(last, fmt.Sprintf("u%d@example.com,", rowsTotal-1)) {
		t.Errorf("unexpected rows: first %q last %q", first, last)
	}

	// ...and stops working once it expires.
	time.Sleep(1500 * time.Millisecond)
	late, err := http.Get(out.ResultURL)
	if err != nil {
		t.Fatal(err)
	}
	late.Body.Close()
	if late.StatusCode != http.StatusForbidden {
		t.Errorf("expired URL status %d, want 403", late.StatusCode)
	}

	pub.mu.Lock()
	defer pub.mu.Unlock()
	if len(pub.seen) != 1 {
		t.Fatalf("published %d events, want 1", len(pub.seen))
	}
	ev := pub.seen[0]
	if ev["_type"] != "system.job.completed" || ev["status"] != "succeeded" || ev["job_id"] != jobID.String() ||
		ev["result_url"] != out.ResultURL || ev["rows_read"] != float64(rowsTotal) || ev["created_by"] != "user-1" {
		t.Errorf("unexpected event: %v", ev)
	}
}
