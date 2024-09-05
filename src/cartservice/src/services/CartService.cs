// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
using System.Diagnostics;
using System.Threading.Tasks;
using System;
using Grpc.Core;
using OpenTelemetry.Trace;
using cartservice.cartstore;
using OpenFeature;
using Oteldemo;
using OpenFeature.Model;

namespace cartservice.services;

public class CartService : Oteldemo.CartService.CartServiceBase
{
    private static readonly Empty Empty = new();
    private readonly Random random = new Random();
    private readonly ICartStore _badCartStore;
    private readonly ICartStore _cartStore;
    private readonly IFeatureClient _featureFlagHelper;
    public static readonly ActivitySource ActivitySource = new("Database");

    public CartService(ICartStore cartStore, ICartStore badCartStore, IFeatureClient featureFlagService)
    {
        _badCartStore = badCartStore;
        _cartStore = cartStore;
        _featureFlagHelper = featureFlagService;
    }

    public override async Task<Empty> AddItem(AddItemRequest request, ServerCallContext context)
    {
        var activity = Activity.Current;
        activity?.SetTag("app.user.id", request.UserId);
        activity?.SetTag("app.product.id", request.Item.ProductId);
        activity?.SetTag("app.product.quantity", request.Item.Quantity);

        await _cartStore.AddItemAsync(request.UserId, request.Item.ProductId, request.Item.Quantity);
        return Empty;
    }

    public override async Task<Cart> GetCart(GetCartRequest request, ServerCallContext context)
    {
        var activity = Activity.Current;
        activity?.SetTag("app.user.id", request.UserId);
        activity?.AddEvent(new("Fetch cart"));

        var cart = await _cartStore.GetCartAsync(request.UserId);
        var totalCart = 0;
        activity?.SetTag("app.cart.unique_items.count", cart.Items.Count);

        _featureFlagHelper.SetContext(
            EvaluationContext.Builder()
                .Set("cart.unique_items.count", cart.Items.Count)
                .Set("user.id", request.UserId)
                .Build());

        var shouldDoDatabaseCall = await _featureFlagHelper.GetBooleanValueAsync("cartservice.add-db-call", false);
        if (!shouldDoDatabaseCall)
        {
            using var dbActivity = ActivitySource.StartActivity("SELECT * FROM products WHERE id = @id", ActivityKind.Client);
                dbActivity?.SetTag("db.statement", "SELECT * FROM products WHERE id IN @ids");
                dbActivity?.SetTag("db.type", "sql");
        }
        foreach (var item in cart.Items)
        {
            if (shouldDoDatabaseCall)
            {
                using var dbActivity = ActivitySource.StartActivity("SELECT * FROM products WHERE id = @id", ActivityKind.Client);
                dbActivity?.SetTag("app.product.id", item.ProductId);
                dbActivity?.SetTag("db.statement", "SELECT * FROM products WHERE id = @id");
                dbActivity?.SetTag("db.type", "sql");
                if (cart.Items.Count > 6)
                {
                    await Task.Delay(random.Next(100, 300));
                }
            }
            totalCart += item.Quantity;
        }
        activity?.SetTag("app.cart.items.count", totalCart);

        return cart;
    }

    public override async Task<Empty> EmptyCart(EmptyCartRequest request, ServerCallContext context)
    {
        var activity = Activity.Current;
        activity?.SetTag("app.user.id", request.UserId);
        activity?.AddEvent(new("Empty cart"));

        try
        {
            // Throw 1/10 of the time to simulate a failure when the feature flag is enabled
            if (await _featureFlagHelper.GetBooleanValueAsync("cartServiceFailure", false) && random.Next(10) == 0)
            {
                await _badCartStore.EmptyCartAsync(request.UserId);
            }
            else
            {
                await _cartStore.EmptyCartAsync(request.UserId);
            }
        }
        catch (RpcException ex)
        {
            Activity.Current?.RecordException(ex);
            Activity.Current?.SetStatus(ActivityStatusCode.Error, ex.Message);
            throw;
        }

        return Empty;
    }
}
