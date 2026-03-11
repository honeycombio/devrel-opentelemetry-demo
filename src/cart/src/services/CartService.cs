// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
using System.Diagnostics;
using System.Linq;
using System.Threading.Tasks;
using System;
using Grpc.Core;
using cart.cartstore;
using Npgsql;
using OpenFeature;
using Oteldemo;
using OpenFeature.Model;
using Microsoft.Extensions.Logging;

namespace cart.services;

public class CartService : Oteldemo.CartService.CartServiceBase
{
    private static readonly Empty Empty = new();
    private readonly ICartStore _badCartStore;
    private readonly ICartStore _cartStore;
    private readonly IFeatureClient _featureFlagHelper;
    private readonly ILogger<CartService> _logger;
    private readonly NpgsqlDataSource _pgDataSource;
    private bool _pgInitialized;

    public CartService(ICartStore cartStore, ICartStore badCartStore, IFeatureClient featureFlagService, ILogger<CartService> logger, NpgsqlDataSource pgDataSource)
    {
        _badCartStore = badCartStore;
        _cartStore = cartStore;
        _featureFlagHelper = featureFlagService;
        _logger = logger;
        _pgDataSource = pgDataSource;
    }

    private async Task EnsureProductsTableAsync()
    {
        if (_pgInitialized) return;

        await using var conn = await _pgDataSource.OpenConnectionAsync();
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
            CREATE TABLE IF NOT EXISTS products (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                price_cents INT NOT NULL
            );
            INSERT INTO products (id, name, description, price_cents) VALUES
                ('OLJCESPC7Z', 'Vintage Typewriter', 'A vintage typewriter for the modern age', 6599),
                ('66VCHSJNUP', 'Vintage Camera Lens', 'A premium camera lens from the 1960s', 12099),
                ('1YMWWN1N4O', 'Home Barista Kit', 'Everything you need to brew cafe-quality coffee', 12400),
                ('L9ECAV7KIM', 'Terrarium', 'A self-sustaining ecosystem in a jar', 3655),
                ('2ZYFJ3GM2N', 'Film Camera', 'A point-and-shoot film camera for everyday use', 2245),
                ('0PUK6V6EV0', 'Vintage Record Player', 'A turntable for vinyl enthusiasts', 6599),
                ('LS4PSXUNUM', 'Metal Camping Mug', 'An insulated mug for outdoor adventures', 2448),
                ('9SIQT8TOJO', 'City Bike', 'A commuter bike for the urban dweller', 78999),
                ('6E92ZMYYFZ', 'Air Plant', 'A low-maintenance plant that thrives on air', 1299),
                ('HQTGWGPNH4', 'Mechanical Pencil Set', 'A set of precision mechanical pencils', 1895)
            ON CONFLICT (id) DO NOTHING;

            CREATE OR REPLACE FUNCTION enrich(product_id TEXT)
            RETURNS TABLE(id TEXT, name TEXT, description TEXT, price_cents INT) AS $$
            BEGIN
                PERFORM pg_sleep(0.01 + random() * 0.19);
                RETURN QUERY SELECT p.id, p.name, p.description, p.price_cents
                    FROM products p WHERE p.id = product_id;
            END;
            $$ LANGUAGE plpgsql;
        ";
        await cmd.ExecuteNonQueryAsync();
        _pgInitialized = true;
        _logger.LogInformation("Products table initialized in PostgreSQL");
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
                    .SetTargetingKey(request.UserId)    
                    .Set("cart.unique_items.count", cart.Items.Count)
                    .Set("app.user.id", request.UserId)
                    .Build());

            var shouldEnrichDatabaseResults = await _featureFlagHelper.GetBooleanValueAsync("cartservice.add-db-call", false);
            activity?.SetTag("app.feature_flag.cart_db_call", shouldEnrichDatabaseResults);

            await EnsureProductsTableAsync();
            if (!shouldEnrichDatabaseResults)
            {
                // Batch query: one SELECT for all cart items (the efficient way)
                var ids = cart.Items.Select(i => i.ProductId).ToArray();
                await using var batchCmd = _pgDataSource.CreateCommand("SELECT * FROM products WHERE id = ANY($1)");
                batchCmd.Parameters.AddWithValue(ids);
                await using var batchReader = await batchCmd.ExecuteReaderAsync();
                while (await batchReader.ReadAsync()) { /* drain results */ }
            }

            foreach (var item in cart.Items)
            {
                if (shouldEnrichDatabaseResults)
                {
                    // N+1 query: enrich each cart item individually (this is the problem the demo reveals)
                    await using var cmd = _pgDataSource.CreateCommand("SELECT * FROM enrich($1)");
                    cmd.Parameters.AddWithValue(item.ProductId);
                    await using var reader = await cmd.ExecuteReaderAsync();
                    while (await reader.ReadAsync()) { /* drain results */ }
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
