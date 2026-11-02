// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import type { NextApiRequest, NextApiResponse } from 'next';
import InstrumentationMiddleware from '../../../../utils/telemetry/InstrumentationMiddleware';
import { Empty, Product } from '../../../../protos/demo';
import ProductCatalogService from '../../../../services/ProductCatalog.service';

import logger from '../../../../utils/telemetry/logger';

type TResponse = Product | Empty;

const handler = async ({ method, query, headers }: NextApiRequest, res: NextApiResponse<TResponse>) => {
  const sessionId = headers['session-id'] as string;
  
  switch (method) {
    case 'GET': {
      const { productId = '', currencyCode = '' } = query;
      
      try {
        const product = await ProductCatalogService.getProduct(productId as string, currencyCode as string);
        
        logger.info({
          'user.id': sessionId,
          'demo.product.id': productId,
          'demo.product.name': product.name,
          'demo.product.price': product.priceUsd?.nanos ? product.priceUsd.nanos / 1000000000 : 0,
          'demo.user_context.selected_currency': currencyCode,
        }, 'Product retrieved successfully');

        return res.status(200).json(product);
      } catch (error) {
        logger.error({
          'user.id': sessionId,
          'demo.product.id': productId,
          'demo.user_context.selected_currency': currencyCode,
          err: error,
        }, 'Failed to retrieve product');
        
        logger.info({
          'user.id': sessionId,
          'demo.product.id': productId,
          'error.type': 'product_not_found',
          'demo.user_context.selected_currency': currencyCode,
        }, 'Product lookup failed - invalid product ID requested');
        
        throw error;
      }
    }

    default: {
      return res.status(405).send('');
    }
  }
};

export default InstrumentationMiddleware(handler);
