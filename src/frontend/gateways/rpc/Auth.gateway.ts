// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { ChannelCredentials } from '@grpc/grpc-js';
import { AuthServiceClient, LoginRequest, LoginResponse } from '../../protos/demo';

const { AUTH_ADDR = '' } = process.env;

const client = new AuthServiceClient(AUTH_ADDR, ChannelCredentials.createInsecure());

const AuthGateway = () => ({
  login(request: LoginRequest) {
    return new Promise<LoginResponse>((resolve, reject) =>
      client.login(request, (error, response) => (error ? reject(error) : resolve(response)))
    );
  },
});

export default AuthGateway();
