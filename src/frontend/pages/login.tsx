// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { NextPage } from 'next';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { FormEvent, useState } from 'react';
import Layout from '../components/Layout';
import Input from '../components/Input';
import ApiGateway from '../gateways/Api.gateway';
import SessionGateway from '../gateways/Session.gateway';
import * as S from '../styles/Login.styled';

const Login: NextPage = () => {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const signIn = async (method: 'password' | 'sso') => {
    setError('');
    setSubmitting(true);
    try {
      const result = await ApiGateway.login(email, method === 'password' ? password : '', method);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const { corporateUserId, company, companyName, email: corporateEmail, displayName } = result.login;
      SessionGateway.setCorporateLogin({ corporateUserId, company, companyName, corporateEmail, displayName });
      router.push('/');
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    signIn('password');
  };

  return (
    <>
      <Head>
        <title>Otel Demo - Log in</title>
      </Head>
      <Layout>
        <S.Login>
          <S.Title>Corporate account log in</S.Title>
          <S.Form id="login-form" onSubmit={onSubmit}>
            <Input
              label="Work email"
              type="email"
              id="email"
              name="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
            />
            <Input
              label="Password"
              type="password"
              id="password"
              name="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
            {error && <S.Error role="alert">{error}</S.Error>}
            <S.Actions>
              <S.SignInButton type="submit" disabled={submitting}>
                Sign in
              </S.SignInButton>
              <S.SignInButton
                type="button"
                $type="secondary"
                disabled={submitting || !email}
                onClick={() => signIn('sso')}
              >
                Sign in with SSO
              </S.SignInButton>
            </S.Actions>
          </S.Form>
        </S.Login>
      </Layout>
    </>
  );
};

export default Login;
