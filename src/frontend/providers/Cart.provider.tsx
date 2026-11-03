// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { createContext, useCallback, useContext, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import ApiGateway from '../gateways/Api.gateway';
import { CartItem, OrderResult, PlaceOrderRequest } from '../protos/demo';
import { IProductCart } from '../types/Cart';
import { useCurrency } from './Currency.provider';
import { spanAttributesForRpc, tracedMutation, tracedQuery } from '../utils/telemetry/SpanUtils';

const TRACER = 'cart-provider';

interface IContext {
  cart: IProductCart;
  addItem(item: CartItem): void;
  updateItemQuantity(productId: string, newQuantity: number): void;
  emptyCart(): void;
  placeOrder(order: PlaceOrderRequest): Promise<OrderResult>;
}

export const Context = createContext<IContext>({
  cart: { userId: '', items: [] },
  addItem: () => {},
  updateItemQuantity: () => {},
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
        queryClient.invalidateQueries({ queryKey: ['cart'] });
      },
    }),
    [queryClient]
  );

  const { data: cart = { userId: '', items: [] } } = useQuery({
    queryKey: ['cart', selectedCurrency],
    queryFn: () => tracedQuery('getCart', () => ApiGateway.getCart(selectedCurrency), TRACER),
  });
  const addCartMutation = useMutation({
    mutationFn: tracedMutation('addCartItem', ApiGateway.addCartItem, TRACER, spanAttributesForRpc('CartService', 'addCartItem', 'CartProvider')),
    ...mutationOptions,
  });

  const emptyCartMutation = useMutation({
    mutationFn: tracedMutation('emptyCart', ApiGateway.emptyCart, TRACER, spanAttributesForRpc('CartService', 'emptyCart', 'CartProvider')),
    ...mutationOptions,
  });

  const placeOrderMutation = useMutation({
    mutationFn: tracedMutation('placeOrder', ApiGateway.placeOrder, TRACER, spanAttributesForRpc('CartService', 'placeOrder', 'CartProvider')),
    ...mutationOptions,
  });

  const addItem = useCallback(
    (item: CartItem) => addCartMutation.mutateAsync({ ...item, currencyCode: selectedCurrency }),
    [addCartMutation, selectedCurrency]
  );

  const updateItemQuantity = useCallback(
    (productId: string, newQuantity: number) => {
      const existing = cart.items.find(i => i.productId === productId);
      const delta = newQuantity - (existing?.quantity ?? 0);
      if (delta !== 0) {
        addCartMutation.mutateAsync({ productId, quantity: delta, currencyCode: selectedCurrency });
      }
    },
    [addCartMutation, cart.items, selectedCurrency]
  );
  // emptyCart takes no variables, but tracedMutation's wrapper needs one argument.
  const emptyCart = useCallback(() => emptyCartMutation.mutateAsync(undefined), [emptyCartMutation]);
  const placeOrder = useCallback(
    (order: PlaceOrderRequest) => placeOrderMutation.mutateAsync({ ...order, currencyCode: selectedCurrency }),
    [placeOrderMutation, selectedCurrency]
  );

  const value = useMemo(() => ({ cart, addItem, updateItemQuantity, emptyCart, placeOrder }), [cart, addItem, updateItemQuantity, emptyCart, placeOrder]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
};

export default CartProvider;
