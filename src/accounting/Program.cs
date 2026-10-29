// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

using Accounting;
using Microsoft.EntityFrameworkCore;

Console.WriteLine("Accounting service started");

Environment.GetEnvironmentVariables()
    .FilterRelevant()
    .OutputInOrder();

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddGrpc();
builder.Services.AddHostedService<Consumer>();

var connectionString = Environment.GetEnvironmentVariable("DB_CONNECTION_STRING");
if (connectionString != null)
{
    builder.Services.AddDbContextFactory<AccountingDbContext>(options =>
        options.UseNpgsql(connectionString).UseSnakeCaseNamingConvention());
}

var paymentAddr = Environment.GetEnvironmentVariable("PAYMENT_ADDR") ?? "payment:50051";
var paymentChannel = Grpc.Net.Client.GrpcChannel.ForAddress($"http://{paymentAddr}");
builder.Services.AddSingleton(new Oteldemo.PaymentService.PaymentServiceClient(paymentChannel));

var catalogAddr = Environment.GetEnvironmentVariable("PRODUCT_CATALOG_ADDR") ?? "product-catalog:8080";
var catalogChannel = Grpc.Net.Client.GrpcChannel.ForAddress($"http://{catalogAddr}");
builder.Services.AddSingleton(new Oteldemo.ProductCatalogService.ProductCatalogServiceClient(catalogChannel));

var currencyAddr = Environment.GetEnvironmentVariable("CURRENCY_ADDR") ?? "currency:8080";
var currencyChannel = Grpc.Net.Client.GrpcChannel.ForAddress($"http://{currencyAddr}");
builder.Services.AddSingleton(new Oteldemo.CurrencyService.CurrencyServiceClient(currencyChannel));

var app = builder.Build();

app.MapGrpcService<OrderServiceImpl>();

app.Run();
