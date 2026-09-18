package auth

import (
	"context"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

// UnaryServerInterceptor authenticates C5 calls from the `authorization`
// metadata. gRPC is internal-only, so it accepts `typ=service` tokens only:
// Unauthenticated without a valid token, PermissionDenied for other types.
func (v *Verifier) UnaryServerInterceptor() grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, _ *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		var header string
		if vals := metadata.ValueFromIncomingContext(ctx, "authorization"); len(vals) > 0 {
			header = vals[0]
		}
		p, err := v.Verify(ctx, bearer(header))
		if err != nil {
			return nil, status.Error(codes.Unauthenticated, "missing or invalid bearer token")
		}
		if !allowed(p, true, nil) {
			return nil, status.Error(codes.PermissionDenied, "service token required")
		}
		return handler(WithPrincipal(ctx, p), req)
	}
}
