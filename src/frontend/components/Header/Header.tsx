// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import CartIcon from '../CartIcon';
import CurrencySwitcher from '../CurrencySwitcher';
import SessionGateway from '../../gateways/Session.gateway';
import * as S from './Header.styled';

const Header = () => {
  // sessionStorage only exists in the browser, so read it after mount.
  const [account, setAccount] = useState<{ companyName: string; displayName: string } | null>(null);

  useEffect(() => {
    const { companyName, displayName } = SessionGateway.getSession();
    setAccount(companyName && displayName ? { companyName, displayName } : null);
  }, []);

  const logOut = () => {
    SessionGateway.clearCorporateLogin();
    setAccount(null);
  };

  return (
    <S.Header>
      <S.NavBar>
        <S.Container>
          <S.NavBarBrand href="/">
            <S.BrandImg id="brand-img"/>
          </S.NavBarBrand>
          <S.Controls>
            {account ? (
              <S.Account>
                <span>{account.companyName} · {account.displayName}</span>
                <S.AccountButton type="button" onClick={logOut}>Log out</S.AccountButton>
              </S.Account>
            ) : (
              <S.Account>
                <S.AccountLink href="/login">Log in</S.AccountLink>
              </S.Account>
            )}
            <CurrencySwitcher />
            <CartIcon />
          </S.Controls>
        </S.Container>
      </S.NavBar>
    </S.Header>
  );
};

export default Header;
