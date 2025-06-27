// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import type { NextApiRequest, NextApiResponse } from 'next';
import InstrumentationMiddleware from '../../../../utils/telemetry/InstrumentationMiddleware';
import { Empty, Product } from '../../../../protos/demo';
import ProductCatalogService from '../../../../services/ProductCatalog.service';

import logger from '../../../../utils/telemetry/Logger';

type TResponse = Product | Empty;

const handler = async ({ method, query, headers }: NextApiRequest, res: NextApiResponse<TResponse>) => {
  const sessionId = headers['session-id'] as string;
  
  switch (method) {
    case 'GET': {
      const { productId = '', currencyCode = '' } = query;
      
      try {
        const product = await ProductCatalogService.getProduct(productId as string, currencyCode as string);
        
        logger.info({
          'app.user.id': sessionId,
          'app.product.id': productId,
          'app.product.name': product.name,
          'app.product.price': product.priceUsd?.nanos ? product.priceUsd.nanos / 1000000000 : 0,
          'app.request.currency': currencyCode,
        }, 'Product retrieved successfully');

        return res.status(200).json(product);
      } catch (error) {
        logger.error({
          'app.user.id': sessionId,
          'app.product.id': productId,
          'app.request.currency': currencyCode,
          err: error,
        }, 'Failed to retrieve product');
        
        logger.info({
          'app.user.id': sessionId,
          'app.product.id': productId,
          'app.error.type': 'product_not_found',
          'app.request.currency': currencyCode,
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
