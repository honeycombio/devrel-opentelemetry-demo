// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { createContext, useCallback, useContext, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import ApiGateway from '../gateways/Api.gateway';
import { CartItem, OrderResult, PlaceOrderRequest } from '../protos/demo';
import { Attributes } from '@opentelemetry/api';
import { IProductCart } from '../types/Cart';
import { useCurrency } from './Currency.provider';
import { spanAttributesForRpc, tracedMutation, tracedQuery } from '../utils/telemetry/SpanUtils';

interface IContext {
  cart: IProductCart;
  addItem(item: CartItem, extraAttributes?: Attributes): void;
  emptyCart(): void;
  placeOrder(order: PlaceOrderRequest & { userCurrency: string}): Promise<OrderResult>;
}

export const Context = createContext<IContext>({
  cart: { userId: '', items: [] },
  addItem: () => {},
  emptyCart: () => {},
  placeOrder: () => Promise.resolve({} as OrderResult),
});

interface IProps {
  children: React.ReactNode;
}

export const useCart = () => useContext(Context);

const CartProvider = ({ children }: IProps) => {
  const { selectedCurrency } = useCurrency();
  const queryClient = useQueryClient();
  const mutationOptions = useMemo(
    () => ({
      onSuccess: () => {
        return queryClient.invalidateQueries({ queryKey: ['cart', selectedCurrency] });
      },
      onFailure: () => {
        // TODO - what do we report here? is this worthy of an OTel exception?
        console.error('Failed to memoize. What now?')
      }
    }),
    [queryClient, selectedCurrency]
  );

  const { data: cart = { userId: '', items: [] } } = useQuery({
    queryKey: ['cart', selectedCurrency],
    queryFn: () => {
      return tracedQuery('getCart', () => ApiGateway.getCart(selectedCurrency), 'cart-provider');
    },
    staleTime: 0,
    // KJR otherwise the app will retry continually on error
    retry: false,
    refetchOnMount: true,
    refetchOnWindowFocus: true
  });

  const addCartMutation = useMutation({
    mutationFn: (payload: CartItem & { currencyCode: string; extraAttributes?: Attributes }) => {
      const { extraAttributes, ...itemData } = payload;
      return tracedMutation(
        'addCartItem',
        (data: CartItem & { currencyCode: string }) => ApiGateway.addCartItem(data),
        'cart-provider',
        {
          ...spanAttributesForRpc('CartService', 'addCartItem', 'CartProvider'),
          ...extraAttributes,
        }
      )(itemData);
    },
    ...mutationOptions,
    retry: false,
  });

  const emptyCartMutation = useMutation({
    mutationFn: tracedMutation('emptyCart', ApiGateway.emptyCart, 'cart-provider', spanAttributesForRpc('CartService', 'emptyCart', 'CartProvider')),
    ...mutationOptions,
    retry: false
  });

  const placeOrderMutation = useMutation({
    mutationFn: (orderDetails: PlaceOrderRequest & { currencyCode: string }) => {
      return tracedMutation(
          'placeOrder',
          (details: PlaceOrderRequest & { currencyCode: string}) => ApiGateway.placeOrder(details),
          'cart-provider',
          {
            ...spanAttributesForRpc('CartService', 'placeOrder', 'CartProvider'),
            'app.order.city': orderDetails?.address?.city || 'No city',
            'app.order.state': orderDetails?.address?.state || 'No state'
          }
      )(orderDetails);
    },
    ...mutationOptions,
    retry: false
  });

  const addItem = useCallback(
    (item: CartItem, extraAttributes?: Attributes) => addCartMutation.mutateAsync({ ...item, currencyCode: selectedCurrency, extraAttributes }),
    [addCartMutation, selectedCurrency]
  );
  // note - we don't have a param to feed the empty cart, so it's undefined
  const emptyCart = useCallback(() => emptyCartMutation.mutateAsync(undefined), [emptyCartMutation]);
  const placeOrder = useCallback(
    (order: PlaceOrderRequest & { userCurrency: string}) => placeOrderMutation.mutateAsync({ ...order, currencyCode: selectedCurrency }),
    [placeOrderMutation, selectedCurrency]
  );

  const value = useMemo(() => ({ cart, addItem, emptyCart, placeOrder }), [cart, addItem, emptyCart, placeOrder]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
};

export default CartProvider;
