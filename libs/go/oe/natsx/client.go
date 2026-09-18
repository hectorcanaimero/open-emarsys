package natsx

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

// Client publishes and consumes C1-enveloped JetStream messages for one
// service (the envelope's "source").
type Client struct {
	nc     *nats.Conn
	js     jetstream.JetStream
	source string
}

// New wraps an existing NATS connection with a JetStream context. source is
// the emitting service name, used as the envelope's "source" field.
func New(nc *nats.Conn, source string) (*Client, error) {
	js, err := jetstream.New(nc)
	if err != nil {
		return nil, err
	}
	return &Client{nc: nc, js: js, source: source}, nil
}

// Publish builds a C1 envelope for data, publishes it to
// "oe.<type>.<tenant_id>" with header Nats-Msg-Id = id, and waits for the
// JetStream ack. It returns the envelope id.
func (c *Client) Publish(ctx context.Context, eventType string, tenantID uuid.UUID, contactID *uuid.UUID, data any) (string, error) {
	env, err := buildEnvelope(ctx, c.source, eventType, tenantID, contactID, data)
	if err != nil {
		return "", err
	}
	raw, err := json.Marshal(env)
	if err != nil {
		return "", err
	}

	msg := &nats.Msg{
		Subject: fmt.Sprintf("oe.%s.%s", eventType, tenantID),
		Data:    raw,
		Header:  nats.Header{"Nats-Msg-Id": []string{env.ID}},
	}
	if _, err := c.js.PublishMsg(ctx, msg); err != nil {
		return "", err
	}
	return env.ID, nil
}
