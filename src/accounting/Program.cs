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

var app = builder.Build();

app.MapGrpcService<OrderServiceImpl>();

app.Run();
