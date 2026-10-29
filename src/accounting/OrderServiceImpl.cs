// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

using System.Diagnostics;
using Grpc.Core;
using Microsoft.EntityFrameworkCore;
using Oteldemo;

namespace Accounting;

internal class OrderServiceImpl : OrderService.OrderServiceBase
{
    private readonly IDbContextFactory<AccountingDbContext> _dbContextFactory;
    private readonly PaymentService.PaymentServiceClient _paymentClient;
    private readonly ProductCatalogService.ProductCatalogServiceClient _catalogClient;
    private readonly CurrencyService.CurrencyServiceClient _currencyClient;
    private readonly ILogger<OrderServiceImpl> _logger;

    // Observatory Hour: "spend more, save more" on these categories, counted over the last 30 minutes.
    private const string PromoCode = "OBSERVATORY";
    private static readonly TimeSpan PromoLookback = TimeSpan.FromMinutes(30);
    private static readonly string[] PromoCategories = ["accessories", "books"];

    public OrderServiceImpl(
        IDbContextFactory<AccountingDbContext> dbContextFactory,
        PaymentService.PaymentServiceClient paymentClient,
        ProductCatalogService.ProductCatalogServiceClient catalogClient,
        CurrencyService.CurrencyServiceClient currencyClient,
        ILogger<OrderServiceImpl> logger)
    {
        _dbContextFactory = dbContextFactory;
        _paymentClient = paymentClient;
        _catalogClient = catalogClient;
        _currencyClient = currencyClient;
        _logger = logger;
    }

    public override async Task<GetOrdersByEmailResponse> GetOrdersByEmail(GetOrdersByEmailRequest request, ServerCallContext context)
    {
        using var db = _dbContextFactory.CreateDbContext();

        // Cap at 10 most-recent orders. The store-chat agent injects this list
        // into conversation history; without a cap, each test customer
        // accumulates orders indefinitely (loadgen reuses 9 fixed emails) and
        // every chat turn writes a larger cache prefix to Bedrock.
        var orders = await db.Orders
            .Where(o => o.Email == request.Email)
            .OrderByDescending(o => o.CreatedAt)
            .Take(10)
            .ToListAsync(context.CancellationToken);

        var response = new GetOrdersByEmailResponse();

        foreach (var order in orders)
        {
            var items = await db.CartItems
                .Where(i => i.OrderId == order.Id)
                .ToListAsync(context.CancellationToken);

            var shipping = await db.Shipping
                .Where(s => s.OrderId == order.Id)
                .FirstOrDefaultAsync(context.CancellationToken);

            response.Orders.Add(MapToOrderDetail(order, items, shipping));
        }

        return response;
    }

    public override async Task<OrderDetail> GetOrder(GetOrderRequest request, ServerCallContext context)
    {
        using var db = _dbContextFactory.CreateDbContext();

        var order = await db.Orders
            .FirstOrDefaultAsync(o => o.Id == request.OrderId, context.CancellationToken);

        if (order == null)
        {
            throw new RpcException(new Status(StatusCode.NotFound, $"Order {request.OrderId} not found"));
        }

        var items = await db.CartItems
            .Where(i => i.OrderId == order.Id)
            .ToListAsync(context.CancellationToken);

        var shipping = await db.Shipping
            .Where(s => s.OrderId == order.Id)
            .FirstOrDefaultAsync(context.CancellationToken);

        var detail = MapToOrderDetail(order, items, shipping);

        // Enrich with payment status if we have a transaction ID
        if (!string.IsNullOrEmpty(order.TransactionId))
        {
            try
            {
                var paymentStatus = await _paymentClient.GetPaymentStatusAsync(
                    new GetPaymentStatusRequest { TransactionId = order.TransactionId },
                    cancellationToken: context.CancellationToken);
                detail.Status = paymentStatus.Status;
            }
            catch (RpcException ex)
            {
                _logger.LogWarning(ex, "Failed to get payment status for transaction {TransactionId}", order.TransactionId);
            }
        }

        return detail;
    }

    public override async Task<RefundOrderResponse> RefundOrder(RefundOrderRequest request, ServerCallContext context)
    {
        using var db = _dbContextFactory.CreateDbContext();

        var order = await db.Orders
            .FirstOrDefaultAsync(o => o.Id == request.OrderId, context.CancellationToken);

        if (order == null)
        {
            throw new RpcException(new Status(StatusCode.NotFound, $"Order {request.OrderId} not found"));
        }

        if (!string.Equals(order.Email, request.Email, StringComparison.OrdinalIgnoreCase))
        {
            throw new RpcException(new Status(StatusCode.PermissionDenied, "Email does not match order"));
        }

        if (order.OrderStatus != "completed")
        {
            throw new RpcException(new Status(StatusCode.FailedPrecondition, $"Order cannot be refunded (status: {order.OrderStatus})"));
        }

        // Call PaymentService.Refund
        var refundAmount = new Money
        {
            CurrencyCode = order.TotalCostCurrencyCode ?? "USD",
            Units = order.TotalCostUnits ?? 0,
            Nanos = order.TotalCostNanos ?? 0,
        };

        var refundResponse = await _paymentClient.RefundAsync(
            new RefundRequest
            {
                TransactionId = order.TransactionId ?? "",
                Amount = refundAmount,
                Email = order.Email ?? "",
            },
            cancellationToken: context.CancellationToken);

        // Update order status
        order.OrderStatus = "refunded";
        order.RefundedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(context.CancellationToken);

        return new RefundOrderResponse
        {
            Success = refundResponse.Success,
            Status = "refunded",
            RefundTransactionId = refundResponse.RefundTransactionId,
        };
    }

    public override async Task<ValidatePromoResponse> ValidatePromo(ValidatePromoRequest request, ServerCallContext context)
    {
        if (!string.Equals(request.PromoCode, PromoCode, StringComparison.OrdinalIgnoreCase))
        {
            return new ValidatePromoResponse { Valid = false };
        }

        using var db = _dbContextFactory.CreateDbContext();
        var ct = context.CancellationToken;
        var windowStart = DateTime.UtcNow - PromoLookback;

        // The tier depends on what this customer has already spent in the window. The orders table keeps the final
        // total but not which lines were eligible, so work it out again from each earlier order's items.
        var earlierOrders = await db.Orders
            .Where(o => o.Email == request.Email && o.CreatedAt >= windowStart)
            .ToListAsync(ct);

        decimal earlierEligibleUsd = 0;
        var itemsScanned = 0;
        foreach (var order in earlierOrders)
        {
            var items = await db.CartItems
                .Where(i => i.OrderId == order.Id)
                .ToListAsync(ct);

            foreach (var item in items)
            {
                itemsScanned++;
                if (!await IsPromoEligibleAsync(item.ProductId, ct))
                {
                    continue;
                }

                var usd = await ToUsdAsync(
                    new Money { CurrencyCode = item.ItemCostCurrencyCode, Units = item.ItemCostUnits, Nanos = item.ItemCostNanos },
                    ct);
                earlierEligibleUsd += usd * item.Quantity;
            }
        }

        decimal thisOrderEligibleUsd = 0;
        decimal thisOrderEligible = 0;
        foreach (var item in request.Items)
        {
            if (!await IsPromoEligibleAsync(item.Item.ProductId, ct))
            {
                continue;
            }

            var cost = ToDecimal(item.Cost) * item.Item.Quantity;
            thisOrderEligible += cost;
            thisOrderEligibleUsd += await ToUsdAsync(item.Cost, ct) * item.Item.Quantity;
        }

        var spendUsd = earlierEligibleUsd + thisOrderEligibleUsd;
        var percent = spendUsd switch
        {
            > 500m => 15,
            >= 200m => 10,
            _ => 5,
        };
        var discount = FromDecimal(request.UserCurrency, Math.Round(thisOrderEligible * percent / 100m, 2));

        var activity = Activity.Current;
        activity?.SetTag("app.promo.code", PromoCode);
        activity?.SetTag("app.promo.window_start", windowStart.ToString("O"));
        activity?.SetTag("app.promo.orders_scanned", earlierOrders.Count);
        activity?.SetTag("app.promo.items_scanned", itemsScanned);
        activity?.SetTag("app.promo.eligible_spend_usd", (double)spendUsd);
        activity?.SetTag("app.promo.discount_percent", percent);

        return new ValidatePromoResponse
        {
            Valid = true,
            DiscountPercent = percent,
            Discount = discount,
            OrdersScanned = earlierOrders.Count,
            ItemsScanned = itemsScanned,
        };
    }

    private async Task<bool> IsPromoEligibleAsync(string productId, CancellationToken ct)
    {
        var product = await _catalogClient.GetProductAsync(new GetProductRequest { Id = productId }, cancellationToken: ct);
        return product.Categories.Any(c => PromoCategories.Contains(c));
    }

    private async Task<decimal> ToUsdAsync(Money money, CancellationToken ct)
    {
        var usd = await _currencyClient.ConvertAsync(
            new CurrencyConversionRequest { From = money, ToCode = "USD" },
            cancellationToken: ct);
        return ToDecimal(usd);
    }

    private static decimal ToDecimal(Money money) => money.Units + money.Nanos / 1_000_000_000m;

    private static Money FromDecimal(string currencyCode, decimal amount)
    {
        var units = (long)decimal.Truncate(amount);
        return new Money
        {
            CurrencyCode = currencyCode,
            Units = units,
            Nanos = (int)((amount - units) * 1_000_000_000m),
        };
    }

    private static OrderDetail MapToOrderDetail(OrderEntity order, List<OrderItemEntity> items, ShippingEntity? shipping)
    {
        var detail = new OrderDetail
        {
            OrderId = order.Id,
            Email = order.Email ?? "",
            Status = order.OrderStatus,
            CreatedAt = order.CreatedAt.ToString("O"),
            TransactionId = order.TransactionId ?? "",
        };

        if (order.TotalCostCurrencyCode != null)
        {
            detail.TotalCost = new Money
            {
                CurrencyCode = order.TotalCostCurrencyCode,
                Units = order.TotalCostUnits ?? 0,
                Nanos = order.TotalCostNanos ?? 0,
            };
        }

        if (shipping != null)
        {
            detail.ShippingTrackingId = shipping.ShippingTrackingId;
            detail.ShippingAddress = new Address
            {
                StreetAddress = shipping.StreetAddress,
                City = shipping.City,
                State = shipping.State,
                Country = shipping.Country,
                ZipCode = shipping.ZipCode,
            };
        }

        foreach (var item in items)
        {
            detail.Items.Add(new OrderItem
            {
                Item = new CartItem
                {
                    ProductId = item.ProductId,
                    Quantity = item.Quantity,
                },
                Cost = new Money
                {
                    CurrencyCode = item.ItemCostCurrencyCode,
                    Units = item.ItemCostUnits,
                    Nanos = item.ItemCostNanos,
                },
            });
        }

        return detail;
    }
}
