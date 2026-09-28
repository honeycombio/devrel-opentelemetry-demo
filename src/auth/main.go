// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"go.opentelemetry.io/contrib/bridges/otelslog"
	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/contrib/instrumentation/runtime"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploggrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/log/global"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/propagation"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	sdkresource "go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"

	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/reflection"

	pb "github.com/open-telemetry/opentelemetry-demo/src/auth/genproto/oteldemo"
)

var logger *slog.Logger
var tracer trace.Tracer
var resource *sdkresource.Resource
var initResourcesOnce sync.Once

func initResource() *sdkresource.Resource {
	initResourcesOnce.Do(func() {
		extraResources, _ := sdkresource.New(
			context.Background(),
			sdkresource.WithOS(),
			sdkresource.WithProcess(),
			sdkresource.WithContainer(),
			sdkresource.WithHost(),
		)
		resource, _ = sdkresource.Merge(
			sdkresource.Default(),
			extraResources,
		)
	})
	return resource
}

func initTracerProvider() *sdktrace.TracerProvider {
	exporter, err := otlptracegrpc.New(context.Background())
	if err != nil {
		logger.Error(fmt.Sprintf("new otlp trace grpc exporter failed: %v", err))
	}
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(initResource()),
	)
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{}))
	return tp
}

func initMeterProvider() *sdkmetric.MeterProvider {
	exporter, err := otlpmetricgrpc.New(context.Background())
	if err != nil {
		logger.Error(fmt.Sprintf("new otlp metric grpc exporter failed: %v", err))
	}
	mp := sdkmetric.NewMeterProvider(
		sdkmetric.WithReader(sdkmetric.NewPeriodicReader(exporter)),
		sdkmetric.WithResource(initResource()),
	)
	otel.SetMeterProvider(mp)
	return mp
}

func initLoggerProvider() *sdklog.LoggerProvider {
	logExporter, err := otlploggrpc.New(context.Background())
	if err != nil {
		return nil
	}
	loggerProvider := sdklog.NewLoggerProvider(
		sdklog.WithProcessor(sdklog.NewBatchProcessor(logExporter)),
		sdklog.WithResource(initResource()),
	)
	global.SetLoggerProvider(loggerProvider)
	return loggerProvider
}

type auth struct {
	pb.UnimplementedAuthServiceServer
	store      *store
	httpClient *http.Client
	logins     metric.Int64Counter
}

func main() {
	var port string
	mustMapEnv(&port, "AUTH_PORT")
	var dbConn string
	mustMapEnv(&dbConn, "DB_CONNECTION_STRING")

	tp := initTracerProvider()
	defer func() { _ = tp.Shutdown(context.Background()) }()
	mp := initMeterProvider()
	defer func() { _ = mp.Shutdown(context.Background()) }()
	lp := initLoggerProvider()
	defer func() {
		if lp != nil {
			_ = lp.Shutdown(context.Background())
		}
	}()

	logger = otelslog.NewLogger("auth")
	slog.SetDefault(logger)

	if err := runtime.Start(runtime.WithMinimumReadMemStatsInterval(time.Second)); err != nil {
		logger.Error(err.Error())
	}

	tracer = tp.Tracer("auth")

	st, err := newStore(context.Background(), dbConn)
	if err != nil {
		logger.Error(fmt.Sprintf("could not connect to database: %v", err))
		os.Exit(1)
	}
	defer st.close()

	logins, err := otel.Meter("auth").Int64Counter("app.auth.logins",
		metric.WithDescription("Login attempts, by company, method and result"))
	if err != nil {
		logger.Error(err.Error())
	}

	svc := &auth{
		store: st,
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
			Transport: otelhttp.NewTransport(http.DefaultTransport,
				otelhttp.WithSpanNameFormatter(func(_ string, r *http.Request) string { return r.Method })),
		},
		logins: logins,
	}

	lis, err := net.Listen("tcp", fmt.Sprintf(":%s", port))
	if err != nil {
		logger.Error(err.Error())
		os.Exit(1)
	}

	srv := grpc.NewServer(grpc.StatsHandler(otelgrpc.NewServerHandler()))
	pb.RegisterAuthServiceServer(srv, svc)
	healthpb.RegisterHealthServer(srv, health.NewServer())
	reflection.Register(srv)

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	go func() {
		logger.Info(fmt.Sprintf("starting to listen on tcp: %q", lis.Addr().String()))
		if err := srv.Serve(lis); err != nil {
			logger.Error(err.Error())
		}
	}()

	<-ctx.Done()
	srv.GracefulStop()
	logger.Info("Auth gRPC server stopped")
}

func mustMapEnv(target *string, envKey string) {
	v := os.Getenv(envKey)
	if v == "" {
		panic(fmt.Sprintf("environment variable %q not set", envKey))
	}
	*target = v
}
