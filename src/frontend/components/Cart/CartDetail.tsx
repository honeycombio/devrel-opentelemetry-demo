// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { useRouter } from 'next/router';
import { useCallback } from 'react';
import CartItems from '../CartItems';
import CheckoutForm from '../CheckoutForm';
import { IFormData } from '../CheckoutForm/CheckoutForm';
import SessionGateway from '../../gateways/Session.gateway';
import { useCart } from '../../providers/Cart.provider';
import { useCurrency } from '../../providers/Currency.provider';
import * as S from '../../styles/Cart.styled';

const { userId } = SessionGateway.getSession();

const CartDetail = () => {
  const {
    cart: { items },
    emptyCart,
    placeOrder,
  } = useCart();
  const { selectedCurrency } = useCurrency();
  const { push } = useRouter();

  const onPlaceOrder = useCallback(
    async ({
      email,
      state,
      streetAddress,
      country,
      city,
      zipCode,
      creditCardCvv,
      creditCardExpirationMonth,
      creditCardExpirationYear,
      creditCardNumber,
    }: IFormData) => {
        try {
            const order = await placeOrder({
                userId,
                email,
                address: {
                    streetAddress,
                    state,
                    country,
                    city,
                    zipCode,
                },
                userCurrency: selectedCurrency,
                creditCard: {
                    creditCardCvv,
                    creditCardExpirationMonth,
                    creditCardExpirationYear,
                    creditCardNumber,
                },
            });

            push({
                pathname: `/cart/checkout/${order.orderId}`,
                query: {order: JSON.stringify(order)},
            });
        } catch (e: unknown) {
            // TODO - visual here that it failed
            // log it for now to the console to know we hit this and swallowed the catch-all exception
            console.error(e);
            // swallow this one - the `placeOrder` reports it in OpenTelmeetry
        }
    },
    [placeOrder, push, selectedCurrency]
  );

  return (
    <S.Container>
      <div>
        <S.Header>
          <S.CarTitle>Shopping Cart</S.CarTitle>
          <S.EmptyCartButton onClick={emptyCart} $type="link">
            Empty Cart
          </S.EmptyCartButton>
        </S.Header>
        <CartItems productList={items} />
      </div>
      <CheckoutForm onSubmit={onPlaceOrder} />
    </S.Container>
  );
};

export default CartDetail;
