// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { v4 } from 'uuid';

export interface ICorporateLogin {
  corporateUserId: string;
  company: string;
  companyName: string;
  corporateEmail: string;
  displayName: string;
}

// Corporate login fields stay flat so the whole session can be used as OpenFeature context.
interface ISession extends Partial<ICorporateLogin> {
  userId: string;
  currencyCode: string;
}

const sessionKey = 'session';
const defaultSession = {
  userId: v4(),
  currencyCode: 'USD',
};

const SessionGateway = () => ({
  getSession(): ISession {
    if (typeof window === 'undefined') return defaultSession;
    const sessionString = sessionStorage.getItem(sessionKey);

    if (!sessionString) sessionStorage.setItem(sessionKey, JSON.stringify(defaultSession));

    return JSON.parse(sessionString || JSON.stringify(defaultSession)) as ISession;
  },
  setSessionValue<K extends keyof ISession>(key: K, value: ISession[K]) {
    const session = this.getSession();

    sessionStorage.setItem(sessionKey, JSON.stringify({ ...session, [key]: value }));
  },
  setCorporateLogin(login: ICorporateLogin) {
    sessionStorage.setItem(sessionKey, JSON.stringify({ ...this.getSession(), ...login }));
  },
  clearCorporateLogin() {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { corporateUserId, company, companyName, corporateEmail, displayName, ...rest } = this.getSession();
    sessionStorage.setItem(sessionKey, JSON.stringify(rest));
  },
});

export default SessionGateway();
