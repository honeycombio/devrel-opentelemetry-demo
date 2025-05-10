// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { createContext, useCallback, useContext, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import ApiGateway from '../gateways/Api.gateway';
import { CartItem, OrderResult, PlaceOrderRequest } from '../protos/demo';
import { IProductCart } from '../types/Cart';
import { useCurrency } from './Currency.provider';
import { spanAttributesForRpc, tracedMutation, tracedQuery } from '../utils/telemetry/SpanUtils';

interface IContext {
  cart: IProductCart;
  addItem(item: CartItem): void;
  emptyCart(): void;
  placeOrder(order: PlaceOrderRequest): Promise<OrderResult>;
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
    }),
    [queryClient, selectedCurrency]
  );

  const { data: cart = { userId: '', items: [] } } = useQuery({
    queryKey: ['cart', selectedCurrency],
    queryFn: () => {
      return tracedQuery('getCart', () => ApiGateway.getCart(selectedCurrency), 'cart-provider');
    },
    staleTime: 0,
    refetchOnMount: true,
    refetchOnWindowFocus: true
  });

  const addCartMutation = useMutation({
    mutationFn: tracedMutation('addCartItem', ApiGateway.addCartItem, 'cart-provider', spanAttributesForRpc('CartService', 'addCartItem', 'CartProvider')),
    ...mutationOptions,
  });

  const emptyCartMutation = useMutation({
    mutationFn: tracedMutation('emptyCart', ApiGateway.emptyCart, 'cart-provider', spanAttributesForRpc('CartService', 'emptyCart', 'CartProvider')),
    ...mutationOptions,
  });

  const placeOrderMutation = useMutation({
    mutationFn: tracedMutation('placeOrder', ApiGateway.placeOrder, 'cart-provider', spanAttributesForRpc('CartService', 'placeOrder', 'CartProvider')),
    ...mutationOptions,
  });

  const addItem = useCallback(
    (item: CartItem) => addCartMutation.mutateAsync({ ...item, currencyCode: selectedCurrency }),
    [addCartMutation, selectedCurrency]
  );
  // note - we don't have a param to feed the empty cart, so it's undefined
  const emptyCart = useCallback(() => emptyCartMutation.mutateAsync(undefined), [emptyCartMutation]);
  const placeOrder = useCallback(
    (order: PlaceOrderRequest) => placeOrderMutation.mutateAsync({ ...order, currencyCode: selectedCurrency }),
    [placeOrderMutation, selectedCurrency]
  );

  const value = useMemo(() => ({ cart, addItem, emptyCart, placeOrder }), [cart, addItem, emptyCart, placeOrder]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
};

export default CartProvider;
