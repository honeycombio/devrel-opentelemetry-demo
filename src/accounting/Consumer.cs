// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

using Confluent.Kafka;
using Google.Protobuf;
using Microsoft.Extensions.Logging;
using Npgsql;
using Oteldemo;
using Microsoft.EntityFrameworkCore;
using System.Diagnostics;

namespace Accounting;

internal class AccountingDbContext : DbContext
{
    public DbSet<OrderEntity> Orders { get; set; }
    public DbSet<OrderItemEntity> CartItems { get; set; }
    public DbSet<ShippingEntity> Shipping { get; set; }

    public AccountingDbContext(DbContextOptions<AccountingDbContext> options) : base(options)
    {
    }
}


internal class Consumer : BackgroundService
{
    private static readonly string TopicName = Environment.GetEnvironmentVariable("KAFKA_TOPIC") ?? "orders";

    private readonly ILogger _logger;
    private readonly string _servers;
    private IConsumer<string, byte[]> _consumer;
    private volatile bool _rebuildRequested;
    private readonly IDbContextFactory<AccountingDbContext>? _dbContextFactory;
    private static readonly ActivitySource MyActivitySource = new("Accounting.Consumer");

    public Consumer(ILogger<Consumer> logger, IDbContextFactory<AccountingDbContext>? dbContextFactory = null)
    {
        _logger = logger;
        _dbContextFactory = dbContextFactory;

        _servers = Environment.GetEnvironmentVariable("KAFKA_ADDR")
            ?? throw new InvalidOperationException("The KAFKA_ADDR environment variable is not set.");

        _consumer = BuildConsumer();
        _consumer.Subscribe(TopicName);

        _logger.LogInformation($"Connecting to Kafka: {_servers}");
    }

    protected override Task ExecuteAsync(CancellationToken stoppingToken)
    {
        return Task.Run(() =>
        {
            try
            {
                while (!stoppingToken.IsCancellationRequested)
                {
                    try
                    {
                        if (_rebuildRequested)
                        {
                            Thread.Sleep(TimeSpan.FromSeconds(1));
                            RebuildConsumer();
                        }

                        var consumeResult = _consumer.Consume(TimeSpan.FromSeconds(1));
                        if (consumeResult == null)
                        {
                            continue;
                        }

                        using var activity = MyActivitySource.StartActivity("order-consumed", ActivityKind.Internal);

                        if (ProcessMessage(consumeResult.Message) == ProcessResult.Processed)
                        {
                            _consumer.Commit(consumeResult);
                        }
                        else
                        {
                            // Rewind so the next Consume() re-delivers the same offset.
                            _consumer.Seek(consumeResult.TopicPartitionOffset);
                            Thread.Sleep(TimeSpan.FromSeconds(1));
                        }
                    }
                    catch (ConsumeException e)
                    {
                        _logger.LogError(e, "Consume error: {0}", e.Error.Reason);
                    }
                    catch (Exception e) when (e is not OperationCanceledException)
                    {
                        // Commit and Seek throw KafkaException, for example when the broker is replaced
                        // and the group no longer exists. The old consumer can stay broken, so build a
                        // new one. The message is redelivered and the duplicate check skips it.
                        _logger.LogError(e, "Consumer loop error; rebuilding the consumer");
                        Thread.Sleep(TimeSpan.FromSeconds(1));
                        RebuildConsumer();
                    }
                }
            }
            finally
            {
                _logger.LogInformation("Closing consumer");
                _consumer.Close();
            }
        }, stoppingToken);
    }

    private void RebuildConsumer()
    {
        try
        {
            _consumer.Dispose();
        }
        catch (Exception e)
        {
            _logger.LogWarning(e, "Failed to dispose the old consumer");
        }

        _rebuildRequested = false;
        _consumer = BuildConsumer();
        _consumer.Subscribe(TopicName);
    }

    private void OnKafkaLog(IConsumer<string, byte[]> consumer, LogMessage log)
    {
        _logger.Log(log.Level <= SyslogLevel.Error ? LogLevel.Error : LogLevel.Debug, "{Facility}: {Message}", log.Facility, log.Message);

        // After the broker is replaced the consumer keeps its old assignment, never sees the
        // new topic, and does not throw. This message is the only sign of it.
        if (log.Level <= SyslogLevel.Error && log.Message.Contains("Unknown topic or partition", StringComparison.Ordinal))
        {
            _rebuildRequested = true;
        }
    }

    private enum ProcessResult
    {
        Processed,
        Retry,
    }

    private ProcessResult ProcessMessage(Message<string, byte[]> message)
    {
        OrderResult order;
        try
        {
            order = OrderResult.Parser.ParseFrom(message.Value);
        }
        catch (InvalidProtocolBufferException ex)
        {
            // Poison pill — unparseable payload will never succeed on retry.
            _logger.LogError(ex, "Dropping unparseable Kafka message");
            return ProcessResult.Processed;
        }

        Log.OrderReceivedMessage(_logger, order);

        if (_dbContextFactory == null)
        {
            return ProcessResult.Processed;
        }

        try
        {
            using var dbContext = _dbContextFactory.CreateDbContext();

            // At-least-once delivery from Kafka + offset commits after DB write
            // means restart windows can replay already-persisted messages.
            // Skip the insert if this order_id is already in the DB.
            if (dbContext.Orders.Any(o => o.Id == order.OrderId))
            {
                return ProcessResult.Processed;
            }

            var orderEntity = new OrderEntity
            {
                Id = order.OrderId,
                // The time the order was placed, so replaying the topic does not make old orders look new.
                CreatedAt = message.Timestamp.Type == TimestampType.NotAvailable ? DateTime.UtcNow : message.Timestamp.UtcDateTime,
                Email = string.IsNullOrEmpty(order.Email) ? null : order.Email,
                UserId = string.IsNullOrEmpty(order.UserId) ? null : order.UserId,
                TransactionId = string.IsNullOrEmpty(order.TransactionId) ? null : order.TransactionId,
                TotalCostCurrencyCode = order.TotalCost?.CurrencyCode,
                TotalCostUnits = order.TotalCost?.Units,
                TotalCostNanos = order.TotalCost?.Nanos,
            };
            dbContext.Add(orderEntity);
            foreach (var item in order.Items)
            {
                var orderItem = new OrderItemEntity
                {
                    ItemCostCurrencyCode = item.Cost.CurrencyCode,
                    ItemCostUnits = item.Cost.Units,
                    ItemCostNanos = item.Cost.Nanos,
                    ProductId = item.Item.ProductId,
                    Quantity = item.Item.Quantity,
                    OrderId = order.OrderId
                };

                dbContext.Add(orderItem);
            }

            var shipping = new ShippingEntity
            {
                ShippingTrackingId = order.ShippingTrackingId,
                ShippingCostCurrencyCode = order.ShippingCost.CurrencyCode,
                ShippingCostUnits = order.ShippingCost.Units,
                ShippingCostNanos = order.ShippingCost.Nanos,
                StreetAddress = order.ShippingAddress.StreetAddress,
                City = order.ShippingAddress.City,
                State = order.ShippingAddress.State,
                Country = order.ShippingAddress.Country,
                ZipCode = order.ShippingAddress.ZipCode,
                OrderId = order.OrderId
            };
            dbContext.Add(shipping);
            dbContext.SaveChanges();
            return ProcessResult.Processed;
        }
        catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: "23505" })
        {
            // Racy idempotent check — row appeared between Any() and SaveChanges().
            // Data is persisted; safe to commit.
            _logger.LogWarning(ex, "Duplicate order {OrderId}; treating as processed", order.OrderId);
            return ProcessResult.Processed;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to persist order {OrderId}; rewinding for retry", order.OrderId);
            return ProcessResult.Retry;
        }
    }

    private IConsumer<string, byte[]> BuildConsumer()
    {
        var conf = new ConsumerConfig
        {
            GroupId = "accounting",
            BootstrapServers = _servers,
            // https://github.com/confluentinc/confluent-kafka-dotnet/tree/07de95ed647af80a0db39ce6a8891a630423b952#basic-consumer-example
            AutoOffsetReset = AutoOffsetReset.Earliest,
            EnableAutoCommit = false,
            QueuedMaxMessagesKbytes = 4096,
            MaxPartitionFetchBytes = 262144,
        };

        return new ConsumerBuilder<string, byte[]>(conf)
            .SetLogHandler(OnKafkaLog)
            .Build();
    }

    public override void Dispose()
    {
        _consumer?.Dispose();
        base.Dispose();
    }
}
