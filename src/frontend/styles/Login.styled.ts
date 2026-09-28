// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import styled from 'styled-components';
import Button from '../components/Button';

export const Login = styled.div`
  margin: 20px;
  max-width: 480px;

  ${({ theme }) => theme.breakpoints.desktop} {
    margin: 100px auto;
  }
`;

export const Title = styled.h1`
  margin: 0 0 32px;
`;

export const Form = styled.form`
  display: flex;
  flex-direction: column;
  gap: 24px;
`;

export const Actions = styled.div`
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
`;

export const SignInButton = styled(Button)`
  flex: 1;
  min-width: 180px;
`;

export const Error = styled.p`
  margin: 0;
  color: #b3261e;
  font-weight: 600;
`;
