# syntax=docker/dockerfile:1
# Build context is the repo root: go.mod replaces libs/go/oe with ../../libs/go/oe.
FROM golang:1.26-alpine AS builder
WORKDIR /repo
COPY libs/go/oe libs/go/oe
COPY services/importer services/importer
WORKDIR /repo/services/importer
ENV GOWORK=off CGO_ENABLED=0
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    go build -trimpath -o /out/importer ./cmd/importer

FROM alpine:3.22
RUN addgroup -S -g 1001 importer && adduser -S -u 1001 -G importer importer
COPY --from=builder /out/importer /usr/local/bin/importer
USER importer
EXPOSE 8080
CMD ["importer"]
