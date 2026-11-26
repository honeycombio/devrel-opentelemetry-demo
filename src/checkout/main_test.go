// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel/trace"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"

	pb "github.com/open-telemetry/opentelemetry-demo/src/checkout/genproto/oteldemo"
)

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (fn roundTripperFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}

func TestSendOrderConfirmationHasBoundedTimeout(t *testing.T) {
	client := &http.Client{
		Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			deadline, ok := req.Context().Deadline()
			if !ok {
				return nil, fmt.Errorf("email request context has no deadline")
			}

			remaining := time.Until(deadline)
			if remaining <= 0 || remaining > time.Second {
				return nil, fmt.Errorf("email request timeout = %v, want at most %v", remaining, time.Second)
			}

			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader("")),
				Header:     make(http.Header),
				Request:    req,
			}, nil
		}),
	}
	cs := &checkout{
		emailSvcAddr: "http://email.test",
		httpClient:   client,
	}

	err := cs.sendOrderConfirmation(context.Background(), "test@example.com", &pb.OrderResult{})
	if err != nil {
		t.Fatalf("sendOrderConfirmation() error = %v", err)
	}
}

func TestHealthCheck(t *testing.T) {
	cs := &checkout{}
	resp, err := cs.Check(context.Background(), &healthpb.HealthCheckRequest{})
	if err != nil {
		t.Fatalf("unexpected error from Check: %v", err)
	}
	if resp.GetStatus() != healthpb.HealthCheckResponse_SERVING {
		t.Errorf("expected SERVING status, got %v", resp.GetStatus())
	}
}

func TestServerStartupAndGracefulStop(t *testing.T) {
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to listen on ephemeral port: %v", err)
	}

	srv := grpc.NewServer()
	svc := &checkout{}
	pb.RegisterCheckoutServiceServer(srv, svc)

	healthcheck := health.NewServer()
	healthpb.RegisterHealthServer(srv, healthcheck)

	serverErrCh := make(chan error, 1)
	go func() {
		serverErrCh <- srv.Serve(lis)
	}()

	conn, err := grpc.NewClient(lis.Addr().String(), grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("failed to connect to test server: %v", err)
	}
	defer conn.Close()

	client := healthpb.NewHealthClient(conn)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	resp, err := client.Check(ctx, &healthpb.HealthCheckRequest{})
	if err != nil {
		t.Fatalf("health check failed on test server: %v", err)
	}
	if resp.GetStatus() != healthpb.HealthCheckResponse_SERVING {
		t.Errorf("expected SERVING, got %v", resp.GetStatus())
	}

	stoppedCh := make(chan struct{})
	go func() {
		srv.GracefulStop()
		close(stoppedCh)
	}()

	select {
	case <-stoppedCh:
		// Graceful stop completed
	case <-time.After(5 * time.Second):
		t.Fatal("GracefulStop timed out")
	}

	select {
	case err := <-serverErrCh:
		if err != nil && err != grpc.ErrServerStopped {
			t.Errorf("unexpected server exit error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("server did not exit after GracefulStop")
	}
}

func TestApplyStandardPromo(t *testing.T) {
	total := &pb.Money{CurrencyCode: "EUR", Units: 33, Nanos: 330_000_000}
	got := applyStandardPromo(trace.SpanFromContext(context.Background()), "stargazer10", 10, total)
	want := &pb.Money{CurrencyCode: "EUR", Units: 29, Nanos: 997_000_000}
	if got.CurrencyCode != want.CurrencyCode || got.Units != want.Units || got.Nanos != want.Nanos {
		t.Errorf("got %v, want %v", got, want)
	}
	if total.Units != 33 || total.Nanos != 330_000_000 {
		t.Errorf("input total was modified: %v", total)
	}
}
