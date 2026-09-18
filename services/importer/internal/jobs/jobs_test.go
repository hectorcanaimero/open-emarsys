package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"

	"github.com/open-emarsys/oe/libs/go/oe/pg"
	"github.com/open-emarsys/oe/libs/go/oe/tenant"
	"github.com/open-emarsys/oe/services/importer/migrations"
)

// newStore starts Postgres and migrates as the unprivileged `importer` role (NOBYPASSRLS, owner
// of its schema), exactly like production, so RLS is really enforced.
func newStore(t *testing.T) *Store {
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
		CREATE SCHEMA importer AUTHORIZATION importer;
		-- pg.Migrate runs CREATE SCHEMA IF NOT EXISTS, which Postgres authorizes before it
		-- looks for the schema; deploy/postgres/init does not grant this yet.
		GRANT CREATE ON DATABASE oe TO importer`); err != nil {
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
	return NewStore(pool)
}

func waitFor(t *testing.T, s *Store, ctx context.Context, id uuid.UUID, cond func(*Job) bool) *Job {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		j, err := s.Get(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		if cond(j) {
			return j
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("timed out waiting for job")
	return nil
}

func TestQueue(t *testing.T) {
	s := newStore(t)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	ctx := tenant.WithTenant(context.Background(), uuid.New())
	opt := Options{Workers: 2, Poll: 20 * time.Millisecond, ProgressEvery: 50 * time.Millisecond, Stale: 400 * time.Millisecond}

	t.Run("worker processes a job", func(t *testing.T) {
		q := NewQueue(s, log, opt)
		q.Handle("test", func(ctx context.Context, j *Job, rep *Reporter) (Outcome, error) {
			if tid, _ := tenant.TenantFrom(ctx); tid != j.TenantID {
				return Outcome{}, errors.New("handler ctx lacks the job's tenant")
			}
			rep.Add(10, 9, 1)
			time.Sleep(120 * time.Millisecond) // long enough for a progress flush
			return Outcome{ResultURL: "http://x/result"}, nil
		})
		wctx, stop := context.WithCancel(context.Background())
		defer stop()
		go q.Run(wctx)

		id, err := s.Enqueue(ctx, "test", map[string]string{"a": "b"}, "user-1")
		if err != nil {
			t.Fatal(err)
		}
		j := waitFor(t, s, ctx, id, func(j *Job) bool { return j.Status == StatusSucceeded })
		if j.Progress.RowsRead != 10 || j.Progress.RowsOK != 9 || j.Progress.RowsFailed != 1 || j.Progress.Percent != 100 {
			t.Fatalf("progress: %+v", j.Progress)
		}
		if j.ResultURL == nil || *j.ResultURL != "http://x/result" || j.FinishedAt == nil || j.Attempts != 1 {
			t.Fatalf("job: %+v", j)
		}
	})

	t.Run("orphaned job is retried after the worker dies", func(t *testing.T) {
		id, err := s.Enqueue(ctx, "crashy", struct{}{}, "user-1")
		if err != nil {
			t.Fatal(err)
		}
		started := make(chan struct{})
		dying := NewQueue(s, log, opt)
		dying.Handle("crashy", func(ctx context.Context, j *Job, rep *Reporter) (Outcome, error) {
			close(started)
			<-ctx.Done() // the process "dies" mid-job
			return Outcome{}, ctx.Err()
		})
		dctx, crash := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() { dying.Run(dctx); close(done) }()
		<-started
		crash()
		<-done
		if j, _ := s.Get(ctx, id); j.Status != StatusRunning {
			t.Fatalf("crashed job should stay running, got %s", j.Status)
		}

		time.Sleep(opt.Stale + 100*time.Millisecond)
		fresh := NewQueue(s, log, opt) // a restart requeues orphans, then a worker reruns it
		fresh.Handle("crashy", func(context.Context, *Job, *Reporter) (Outcome, error) { return Outcome{}, nil })
		wctx, stop := context.WithCancel(context.Background())
		defer stop()
		go fresh.Run(wctx)
		j := waitFor(t, s, ctx, id, func(j *Job) bool { return j.Status == StatusSucceeded })
		if j.Attempts != 2 {
			t.Fatalf("attempts: got %d, want 2", j.Attempts)
		}
	})

	t.Run("orphan out of attempts fails", func(t *testing.T) {
		id, _ := s.Enqueue(ctx, "gone", struct{}{}, "u")
		for range 2 {
			if j, err := s.claim(context.Background()); err != nil || j == nil {
				t.Fatalf("claim: %v %v", j, err)
			}
			time.Sleep(opt.Stale + 50*time.Millisecond)
			if _, err := s.requeueOrphans(context.Background(), opt.Stale, 2); err != nil {
				t.Fatal(err)
			}
		}
		if j, _ := s.Get(ctx, id); j.Status != StatusFailed {
			t.Fatalf("status: got %s, want failed", j.Status)
		}
	})
}

func TestTenantIsolation(t *testing.T) {
	s := newStore(t)
	a := tenant.WithTenant(context.Background(), uuid.New())
	b := tenant.WithTenant(context.Background(), uuid.New())
	id, err := s.Enqueue(a, "test", struct{}{}, "u")
	if err != nil {
		t.Fatal(err)
	}

	if _, err := s.Get(b, id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("other tenant Get: got %v, want ErrNotFound", err)
	}
	if items, _, err := s.List(b, "", 10); err != nil || len(items) != 0 {
		t.Fatalf("other tenant List: %v %v", items, err)
	}
	if items, _, err := s.List(a, "", 10); err != nil || len(items) != 1 {
		t.Fatalf("own List: %v %v", items, err)
	}
	if _, err := s.Get(context.Background(), id); !errors.Is(err, pg.ErrNoTenant) {
		t.Fatalf("no tenant Get: got %v, want ErrNoTenant", err)
	}

	get := func(ctx context.Context, path string, h http.HandlerFunc) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, path, nil).WithContext(ctx)
		req.SetPathValue("id", id.String())
		w := httptest.NewRecorder()
		h(w, req)
		return w
	}
	if w := get(b, "/api/v3/jobs/"+id.String(), s.publicGet); w.Code != http.StatusNotFound {
		t.Fatalf("other tenant public GET: %d %s", w.Code, w.Body)
	}
	if w := get(b, "/admin/v1/jobs/"+id.String(), s.adminGet); w.Code != http.StatusNotFound {
		t.Fatalf("other tenant admin GET: %d %s", w.Code, w.Body)
	}
	w := get(a, "/api/v3/jobs/"+id.String(), s.publicGet)
	var env struct {
		ReplyCode int
		Data      struct {
			ID     uuid.UUID
			Status string
		}
	}
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil || w.Code != 200 || env.Data.ID != id || env.Data.Status != StatusQueued {
		t.Fatalf("own public GET: %d %s", w.Code, w.Body)
	}
}
