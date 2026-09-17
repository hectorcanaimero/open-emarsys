package httpx

import (
	"log/slog"
	"net/http"
)

// NewServer wraps mux with the standard middleware chain — recover, request
// id, OTel span, access log, in that order from outermost to innermost —
// and returns an *http.Server listening on addr.
func NewServer(addr string, mux http.Handler, serviceName string, logger *slog.Logger) *http.Server {
	handler := Recover(logger)(
		RequestID(
			OTel(serviceName)(
				AccessLog(logger)(mux),
			),
		),
	)
	return &http.Server{
		Addr:    addr,
		Handler: handler,
	}
}
