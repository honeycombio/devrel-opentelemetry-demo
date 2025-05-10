// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { createContext, useContext, useMemo } from 'react';
import { trace, context, SpanStatusCode, metrics } from '@opentelemetry/api';
import { useQuery } from '@tanstack/react-query';
import ApiGateway from '../gateways/Api.gateway';
import { Ad, Money, Product } from '../protos/demo';
import { useCurrency } from './Currency.provider';
import { recordExceptionAndMarkSpanError, tracedQuery } from '../utils/telemetry/SpanUtils';

const tracer = trace.getTracer('ads-provider');

interface IContext {
  recommendedProductList: Product[];
  adList: Ad[];
}

export const Context = createContext<IContext>({
  recommendedProductList: [],
  adList: [],
});

interface IProps {
  children: React.ReactNode;
  productIds: string[];
  contextKeys: string[];
}

export const useAd = () => useContext(Context);

const AdProvider = ({ children, productIds, contextKeys }: IProps) => {
  const { selectedCurrency } = useCurrency();
  const { data: adList = [], isError, error } = useQuery({
    queryKey: ['ads', contextKeys],
    queryFn: () => {
      if (contextKeys.length === 0) {
        return Promise.resolve([]);
      }
      return tracedQuery('getCart', () => ApiGateway.listAds(contextKeys), 'ad-provider');
    },
    refetchOnWindowFocus: false,
  });

  const { data: recommendedProductList = [] } = useQuery({
    queryKey: ['recommendations', productIds, 'selectedCurrency', selectedCurrency],
    queryFn: () => ApiGateway.listRecommendations(productIds, selectedCurrency),
    refetchOnWindowFocus: false,
  });

  const value = useMemo(
    () => ({
      adList,
      recommendedProductList,
    }),
    [adList, recommendedProductList]
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
};

export default AdProvider;
