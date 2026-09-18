package jobs

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/open-emarsys/oe/libs/go/oe/tenant"
)

// Outcome is what a successful handler hands back for the job row.
type Outcome struct{ ResultURL, ErrorReportURL string }

// Handler runs one job. ctx carries the job's tenant. Returning an error fails the job;
// if ctx is cancelled (shutdown or crash) the job is left running and recovered as an orphan.
type Handler func(ctx context.Context, j *Job, rep *Reporter) (Outcome, error)

// Reporter accumulates progress; the queue persists it every ProgressEvery.
type Reporter struct {
	mu sync.Mutex
	p  Progress
}

func (r *Reporter) Add(read, ok, failed int64) {
	r.mu.Lock()
	r.p.RowsRead += read
	r.p.RowsOK += ok
	r.p.RowsFailed += failed
	r.mu.Unlock()
}

func (r *Reporter) SetPercent(pct float64) {
	r.mu.Lock()
	r.p.Percent = pct
	r.mu.Unlock()
}

func (r *Reporter) snapshot() Progress {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.p
}

type Options struct {
	Workers       int           // concurrent jobs (default 2)
	Poll          time.Duration // idle wait between claims (default 1s)
	ProgressEvery time.Duration // progress flush and heartbeat (default 5s)
	Stale         time.Duration // heartbeat age after which a running job is an orphan (default 6x ProgressEvery)
	MaxAttempts   int           // runs per job before an orphan is failed (default 3)
}

type Queue struct {
	store    *Store
	log      *slog.Logger
	opt      Options
	handlers map[string]Handler
}

func NewQueue(store *Store, log *slog.Logger, opt Options) *Queue {
	if opt.Workers <= 0 {
		opt.Workers = 2
	}
	if opt.Poll <= 0 {
		opt.Poll = time.Second
	}
	if opt.ProgressEvery <= 0 {
		opt.ProgressEvery = 5 * time.Second
	}
	if opt.Stale <= 0 {
		opt.Stale = 6 * opt.ProgressEvery
	}
	if opt.MaxAttempts <= 0 {
		opt.MaxAttempts = 3
	}
	return &Queue{store: store, log: log, opt: opt, handlers: map[string]Handler{}}
}

// Handle registers the handler for a job kind. Call it before Run.
func (q *Queue) Handle(kind string, h Handler) { q.handlers[kind] = h }

// Run requeues orphans, then works jobs until ctx is done.
func (q *Queue) Run(ctx context.Context) {
	q.recover(ctx)
	var wg sync.WaitGroup
	wg.Add(q.opt.Workers + 1)
	go func() { // janitor: covers workers that die while this replica stays up
		defer wg.Done()
		t := time.NewTicker(q.opt.Stale / 2)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				q.recover(ctx)
			}
		}
	}()
	for range q.opt.Workers {
		go func() {
			defer wg.Done()
			q.work(ctx)
		}()
	}
	wg.Wait()
}

func (q *Queue) recover(ctx context.Context) {
	n, err := q.store.requeueOrphans(ctx, q.opt.Stale, q.opt.MaxAttempts)
	if err != nil && ctx.Err() == nil {
		q.log.ErrorContext(ctx, "requeue orphans", "error", err)
	} else if n > 0 {
		q.log.WarnContext(ctx, "orphaned jobs requeued or failed", "count", n)
	}
}

func (q *Queue) work(ctx context.Context) {
	for ctx.Err() == nil {
		j, err := q.store.claim(ctx)
		if err != nil && ctx.Err() == nil {
			q.log.ErrorContext(ctx, "claim job", "error", err)
		}
		if j == nil {
			select {
			case <-ctx.Done():
			case <-time.After(q.opt.Poll):
			}
			continue
		}
		q.run(ctx, j)
	}
}

func (q *Queue) run(ctx context.Context, j *Job) {
	h, ok := q.handlers[j.Kind]
	if !ok {
		_ = q.store.finish(ctx, j.ID, StatusFailed, j.Progress, Outcome{}, "no handler for kind "+j.Kind)
		return
	}
	rep := &Reporter{p: j.Progress}
	jctx := tenant.WithTenant(ctx, j.TenantID)

	stop := make(chan struct{})
	flushed := make(chan struct{})
	go func() {
		defer close(flushed)
		t := time.NewTicker(q.opt.ProgressEvery)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				if err := q.store.saveProgress(ctx, j.ID, rep.snapshot()); err != nil && ctx.Err() == nil {
					q.log.ErrorContext(ctx, "save progress", "job_id", j.ID, "error", err)
				}
			}
		}
	}()
	out, err := h(jctx, j, rep)
	close(stop)
	<-flushed

	if ctx.Err() != nil { // worker going down: leave the job running for orphan recovery
		return
	}
	p := rep.snapshot()
	if err != nil {
		q.log.ErrorContext(ctx, "job failed", "job_id", j.ID, "kind", j.Kind, "error", err)
		err = q.store.finish(ctx, j.ID, StatusFailed, p, out, err.Error())
	} else {
		p.Percent = 100
		err = q.store.finish(ctx, j.ID, StatusSucceeded, p, out, "")
	}
	if err != nil {
		q.log.ErrorContext(ctx, "finish job", "job_id", j.ID, "error", err)
	}
}
