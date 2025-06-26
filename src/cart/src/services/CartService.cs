// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
using System.Diagnostics;
using System.Threading.Tasks;
using System;
using Grpc.Core;
using cart.cartstore;
using OpenFeature;
using Oteldemo;
using OpenFeature.Model;
using Microsoft.Extensions.Logging;

namespace cart.services;

public class CartService : Oteldemo.CartService.CartServiceBase
{
    private static readonly Empty Empty = new();
    private readonly Random random = new Random();
    private readonly ICartStore _badCartStore;
    private readonly ICartStore _cartStore;
    private readonly IFeatureClient _featureFlagHelper;
    private readonly ILogger<CartService> _logger;
    public static readonly ActivitySource ActivitySource = new("Database");

    public CartService(ICartStore cartStore, ICartStore badCartStore, IFeatureClient featureFlagService, ILogger<CartService> logger)
    {
        _badCartStore = badCartStore;
        _cartStore = cartStore;
        _featureFlagHelper = featureFlagService;
        _logger = logger;
    }

    public override async Task<Empty> AddItem(AddItemRequest request, ServerCallContext context)
    {
        var activity = Activity.Current;
        activity?.SetTag("app.user.id", request.UserId);
        activity?.SetTag("app.product.id", request.Item.ProductId);
        activity?.SetTag("app.product.quantity", request.Item.Quantity);

        try
        {
            await _cartStore.AddItemAsync(request.UserId, request.Item.ProductId, request.Item.Quantity);

            _logger.LogInformation("Added {Quantity} of product {ProductId} to cart for user {app.user.id}", 
                request.Item.Quantity, request.Item.ProductId, request.UserId);

            return Empty;
        }
        catch (RpcException ex)
        {
            activity?.AddException(ex);
            activity?.SetStatus(ActivityStatusCode.Error, ex.Message);
            
            _logger.LogError("Failed to add product {ProductId} to cart for user {app.user.id}: {ErrorMessage}", 
                request.Item.ProductId, request.UserId, ex.Message);
            
            _logger.LogInformation("Cart operation failure context - User: {app.user.id}, Product: {ProductId}, Quantity: {Quantity}, RequestedAt: {Timestamp}", 
                request.UserId, request.Item.ProductId, request.Item.Quantity, DateTimeOffset.UtcNow);
            _logger.LogInformation("Cart failure environment - Session: {SessionId}, TraceId: {TraceId}", 
                activity?.GetBaggageItem("session.id"), activity?.TraceId);
            _logger.LogInformation("Cart store type: {StoreType}, User-Agent: {UserAgent}", 
                _cartStore.GetType().Name, context.GetHttpContext()?.Request.Headers["User-Agent"].ToString());
            
            throw;
        }
    }

    public override async Task<Cart> GetCart(GetCartRequest request, ServerCallContext context)
    {
        var activity = Activity.Current;
        activity?.SetTag("app.user.id", request.UserId);
        activity?.AddEvent(new("Fetch cart"));

        try
        {
            var cart = await _cartStore.GetCartAsync(request.UserId);
            var totalCart = 0;
            activity?.SetTag("app.cart.unique_items.count", cart.Items.Count);

            _featureFlagHelper.SetContext(
                EvaluationContext.Builder()
                    .Set("cart.unique_items.count", cart.Items.Count)
                    .Set("app.user.id", request.UserId)
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

            _logger.LogInformation("Cart retrieved for user {app.user.id} with {ItemCount} unique items, {TotalQuantity} total items", 
                request.UserId, cart.Items.Count, totalCart);

            return cart;
        }
        catch (RpcException ex)
        {
            activity?.AddException(ex);
            activity?.SetStatus(ActivityStatusCode.Error, ex.Message);
            
            _logger.LogError("Failed to retrieve cart for user {app.user.id}: {ErrorMessage}", 
                request.UserId, ex.Message);
            
            _logger.LogInformation("Cart retrieval failure context - User: {app.user.id}, RequestedAt: {Timestamp}", 
                request.UserId, DateTimeOffset.UtcNow);
            _logger.LogInformation("Cart failure environment - Session: {SessionId}, TraceId: {TraceId}", 
                activity?.GetBaggageItem("session.id"), activity?.TraceId);
            _logger.LogInformation("Cart store type: {StoreType}, User-Agent: {UserAgent}", 
                _cartStore.GetType().Name, context.GetHttpContext()?.Request.Headers["User-Agent"].ToString());
            
            throw;
        }
    }

    public override async Task<Empty> EmptyCart(EmptyCartRequest request, ServerCallContext context)
    {
        var activity = Activity.Current;
        activity?.SetTag("app.user.id", request.UserId);
        activity?.AddEvent(new("Empty cart"));

        try
        {
            var cartFailureEnabled = await _featureFlagHelper.GetBooleanValueAsync("cartFailure", false);
            
            if (cartFailureEnabled)
            {
                _logger.LogInformation("Using bad cart store due to cartFailure feature flag for user {app.user.id}", request.UserId);
                await _badCartStore.EmptyCartAsync(request.UserId);
            }
            else
            {
                await _cartStore.EmptyCartAsync(request.UserId);
            }
            
            _logger.LogInformation("Cart emptied for user {app.user.id}, cartFailure flag: {CartFailureEnabled}", 
                request.UserId, cartFailureEnabled);
        }
        catch (RpcException ex)
        {
            Activity.Current?.AddException(ex);
            Activity.Current?.SetStatus(ActivityStatusCode.Error, ex.Message);
            
            _logger.LogError("Failed to empty cart for user {app.user.id}: {ErrorMessage}", 
                request.UserId, ex.Message);
            
            var cartFailureEnabled = await _featureFlagHelper.GetBooleanValueAsync("cartFailure", false);
            _logger.LogInformation("Cart empty failure context - User: {app.user.id}, CartFailureFlag: {CartFailureEnabled}, RequestedAt: {Timestamp}", 
                request.UserId, cartFailureEnabled, DateTimeOffset.UtcNow);
            _logger.LogInformation("Cart failure environment - Session: {SessionId}, TraceId: {TraceId}", 
                activity?.GetBaggageItem("session.id"), activity?.TraceId);
            _logger.LogInformation("Store types - Primary: {PrimaryStoreType}, Bad: {BadStoreType}, User-Agent: {UserAgent}", 
                _cartStore.GetType().Name, _badCartStore.GetType().Name, context.GetHttpContext()?.Request.Headers["User-Agent"].ToString());
            
            throw;
        }

        return Empty;
    }
}
