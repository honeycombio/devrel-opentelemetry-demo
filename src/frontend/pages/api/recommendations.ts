// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import type { NextApiRequest, NextApiResponse } from 'next';
import InstrumentationMiddleware from '../../utils/telemetry/InstrumentationMiddleware';
import RecommendationsGateway from '../../gateways/rpc/Recommendations.gateway';
import { Empty, Product } from '../../protos/demo';
import ProductCatalogService from '../../services/ProductCatalog.service';

import logger from '../../utils/telemetry/Logger';

type TResponse = Product[] | Empty;

const handler = async ({ method, query }: NextApiRequest, res: NextApiResponse<TResponse>) => {
  switch (method) {
    case 'GET': {
      const { productIds = [], sessionId = '', currencyCode = '' } = query;
      
      try {
        const { productIds: productList } = await RecommendationsGateway.listRecommendations(
          sessionId as string,
          productIds as string[]
        );
        const recommendedProductList = await Promise.all(
          productList.slice(0, 4).map(id => ProductCatalogService.getProduct(id, currencyCode as string))
        );

        logger.info({
          'app.user.id': sessionId,
          'app.recommendations.input_product_count': Array.isArray(productIds) ? productIds.length : 1,
          'app.recommendations.returned_count': recommendedProductList.length,
          'app.recommendations.product_ids': productList.slice(0, 4),
          'app.request.currency': currencyCode,
        }, 'Recommendations retrieved successfully');

        return res.status(200).json(recommendedProductList);
      } catch (error) {
        logger.error({
          'app.user.id': sessionId,
          'app.recommendations.input_product_count': Array.isArray(productIds) ? productIds.length : 1,
          'app.request.currency': currencyCode,
          err: error,
        }, 'Failed to retrieve recommendations');
        
        logger.info({
          'app.user.id': sessionId,
          'app.error.type': 'recommendations_failed',
          'app.recommendations.input_product_count': Array.isArray(productIds) ? productIds.length : 1,
          'app.request.currency': currencyCode,
        }, 'Recommendations retrieval failed - unable to get product suggestions');
        
        throw error;
      }
    }

    default: {
      return res.status(405).send('');
    }
  }
};

export default InstrumentationMiddleware(handler);
