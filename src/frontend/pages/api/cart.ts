// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import type { NextApiHandler } from 'next';
import CartGateway from '../../gateways/rpc/Cart.gateway';
import { AddItemRequest, Empty } from '../../protos/demo';
import ProductCatalogService from '../../services/ProductCatalog.service';
import { IProductCart, IProductCartItem } from '../../types/Cart';
import InstrumentationMiddleware from '../../utils/telemetry/InstrumentationMiddleware';

import logger from '../../utils/telemetry/Logger';

type TResponse = IProductCart | Empty;

const handler: NextApiHandler<TResponse> = async ({ method, body, query }, res) => {
  switch (method) {
    case 'GET': {
      const { sessionId = '', currencyCode = '' } = query;
      
      try {
        const { userId, items } = await CartGateway.getCart(sessionId as string);

        const productList: IProductCartItem[] = await Promise.all(
          items.map(async ({ productId, quantity }) => {
            const product = await ProductCatalogService.getProduct(productId, currencyCode as string);

            return {
              productId,
              quantity,
              product,
            };
          })
        );

        logger.info({
          'app.user.id': sessionId,
          'app.cart.item_count': items.length,
          'app.cart.total_quantity': items.reduce((sum, item) => sum + item.quantity, 0),
          'app.request.currency': currencyCode,
        }, 'Cart retrieved successfully');

        return res.status(200).json({ userId, items: productList });
      } catch (error) {
        logger.error({
          'app.user.id': sessionId,
          'app.request.currency': currencyCode,
          err: error,
        }, 'Failed to retrieve cart');
        
        logger.info({
          'app.user.id': sessionId,
          'app.error.type': 'cart_retrieval_failed',
          'app.request.currency': currencyCode,
        }, 'Cart retrieval failed - unable to load user cart');
        
        throw error;
      }
    }

    case 'POST': {
      const { userId, item } = body as AddItemRequest;

      try {
        await CartGateway.addItem(userId, item!);
        const cart = await CartGateway.getCart(userId);

        logger.info({
          'app.user.id': userId,
          'app.product.id': item?.productId,
          'app.cart.quantity_added': item?.quantity,
          'app.cart.total_items': cart.items.length,
        }, 'Item added to cart successfully');

        return res.status(200).json(cart);
      } catch (error) {
        logger.error({
          'app.user.id': userId,
          'app.product.id': item?.productId,
          'app.cart.quantity_requested': item?.quantity,
          err: error,
        }, 'Failed to add item to cart');
        
        logger.info({
          'app.user.id': userId,
          'app.product.id': item?.productId,
          'app.error.type': 'cart_add_failed',
          'app.cart.quantity_requested': item?.quantity,
        }, 'Cart add operation failed - unable to add item to user cart');
        
        throw error;
      }
    }

    case 'DELETE': {
      const { userId } = body as AddItemRequest;
      
      try {
        await CartGateway.emptyCart(userId);

        logger.info({
          'app.user.id': userId,
          'app.cart.action': 'empty',
        }, 'Cart emptied successfully');

        return res.status(204).send('');
      } catch (error) {
        logger.error({
          'app.user.id': userId,
          err: error,
        }, 'Failed to empty cart');
        
        logger.info({
          'app.user.id': userId,
          'app.error.type': 'cart_empty_failed',
        }, 'Cart empty operation failed - unable to clear user cart');
        
        throw error;
      }
    }

    default: {
      return res.status(405);
    }
  }
};

export default InstrumentationMiddleware(handler);
