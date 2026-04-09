// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import type { NextApiRequest, NextApiResponse } from 'next';
import InstrumentationMiddleware from '../../../../utils/telemetry/InstrumentationMiddleware';
import OrderGateway from '../../../../gateways/rpc/Order.gateway';

const handler = async ({ method, query, body }: NextApiRequest, res: NextApiResponse) => {
  switch (method) {
    case 'POST': {
      const { orderId } = query;
      const { email } = body;
      const result = await OrderGateway.refundOrder(orderId as string, email as string);

      return res.status(200).json(result);
    }

    default: {
      return res.status(405).send('');
    }
  }
};

export default InstrumentationMiddleware(handler);
