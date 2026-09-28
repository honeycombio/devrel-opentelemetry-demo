// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import type { NextApiRequest, NextApiResponse } from 'next';
import { ServiceError, status } from '@grpc/grpc-js';
import { trace } from '@opentelemetry/api';
import InstrumentationMiddleware from '../../utils/telemetry/InstrumentationMiddleware';
import AuthGateway from '../../gateways/rpc/Auth.gateway';
import { LoginRequest, LoginResponse } from '../../protos/demo';
import logger from '../../utils/telemetry/Logger';

type TResponse = LoginResponse | { error: string };

const httpStatusFor: Partial<Record<status, number>> = {
  [status.UNAUTHENTICATED]: 401,
  [status.PERMISSION_DENIED]: 403,
  [status.FAILED_PRECONDITION]: 409,
  [status.INVALID_ARGUMENT]: 400,
  [status.UNAVAILABLE]: 503,
};

const handler = async ({ method, body }: NextApiRequest, res: NextApiResponse<TResponse>) => {
  switch (method) {
    case 'POST': {
      const { email = '', password = '', method: loginMethod = 'password' } = body as LoginRequest;
      const span = trace.getActiveSpan();
      span?.setAttribute('app.auth.method', loginMethod);

      try {
        const login = await AuthGateway.login({ email, password, method: loginMethod });
        span?.setAttributes({
          'app.company': login.company,
          'app.corporate_user.id': login.corporateUserId,
        });
        return res.status(200).json(login);
      } catch (error: unknown) {
        const code = (error as ServiceError).code;
        const httpStatus = httpStatusFor[code];
        if (httpStatus === undefined) throw error;

        logger.info({ 'app.auth.method': loginMethod, 'rpc.grpc.status_code': code }, 'Login rejected');
        return res.status(httpStatus).json({ error: (error as ServiceError).details || 'Login failed' });
      }
    }

    default: {
      return res.status(405).send({ error: 'Method not allowed' });
    }
  }
};

export default InstrumentationMiddleware(handler);
