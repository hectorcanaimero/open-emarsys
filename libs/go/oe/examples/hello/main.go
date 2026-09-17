// Command hello is a minimal service wired with oe/config, oe/log, oe/otel
// and oe/httpx: every request to /hello runs inside a span exported to the
// F0.2.T3 OpenTelemetry Collector, visible in Tempo.
package main

import (
	"context"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/open-emarsys/oe/libs/go/oe/config"
	"github.com/open-emarsys/oe/libs/go/oe/httpx"
	oelog "github.com/open-emarsys/oe/libs/go/oe/log"
	oeotel "github.com/open-emarsys/oe/libs/go/oe/otel"
)

const serviceName = "hello"

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	shutdown, err := oeotel.Setup(ctx, serviceName)
	if err != nil {
		panic(err)
	}
	defer func() { _ = shutdown(context.Background()) }()

	logger := oelog.New(serviceName, os.Stdout)
	cfg := config.New("HELLO")
	addr := cfg.String("ADDR", ":8080")

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", httpx.Healthz)
	mux.HandleFunc("/readyz", httpx.Readyz())
	mux.HandleFunc("/hello", func(w http.ResponseWriter, r *http.Request) {
		httpx.WriteEnvelope(w, 0, "OK", map[string]string{"message": "hello, open-emarsys"})
	})

	srv := httpx.NewServer(addr, mux, serviceName, logger)

	logger.InfoContext(ctx, "starting", "addr", addr)
	go func() {
		<-ctx.Done()
		_ = srv.Shutdown(context.Background())
	}()
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		logger.ErrorContext(ctx, "server error", "error", err)
		os.Exit(1)
	}
}
