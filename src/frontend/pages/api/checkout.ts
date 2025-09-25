// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import type { NextApiRequest, NextApiResponse } from 'next';
import InstrumentationMiddleware from '../../utils/telemetry/InstrumentationMiddleware';
import CheckoutGateway from '../../gateways/rpc/Checkout.gateway';
import { Empty, PlaceOrderRequest } from '../../protos/demo';
import { IProductCheckoutItem, IProductCheckout } from '../../types/Cart';
import ProductCatalogService from '../../services/ProductCatalog.service';
import logger from '../../utils/telemetry/Logger';

type TResponse = IProductCheckout | Empty;

const handler = async ({ method, body, query }: NextApiRequest, res: NextApiResponse<TResponse>) => {
  switch (method) {
    case 'POST': {
      const { currencyCode = '' } = query;
      const orderData = body as PlaceOrderRequest;
      const userId = orderData.userId || '';
      
      try {
        const { order: { items = [], ...order } = {} } = await CheckoutGateway.placeOrder(orderData);

        const productList: IProductCheckoutItem[] = await Promise.all(
          items.map(async ({ item: { productId = '', quantity = 0 } = {}, cost }) => {
            const product = await ProductCatalogService.getProduct(productId, currencyCode as string);
            return {
              cost,
              item: {
                productId,
                quantity,
                product,
              },
            };
          })
        );

        const totalCost = items.reduce((sum, item) => {
          const cost = item.cost?.nanos ? item.cost.nanos / 1000000000 : 0;
          return sum + cost;
        }, 0);

        logger.info({
          'app.user.id': userId,
          'app.order.total_cost': totalCost,
          'app.order.item_count': items.length,
        }, 'Order placed successfully');
        return res.status(200).json({ ...order, items: productList });
      } catch (error: unknown) {
        if (error instanceof Error) {
          console.error("CALL FAILED IN Provider")
        }
        // logger.error({
        //   'app.user.id': userId,
        //   'app.request.currency': currencyCode,
        //   err: error,
        // }, 'Failed to place order');
        
        throw error;
      }
    }

    default: {
      return res.status(405).send('');
    }
  }
};

export default InstrumentationMiddleware(handler);
