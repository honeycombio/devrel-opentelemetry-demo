// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import type { NextApiRequest, NextApiResponse } from 'next';
import InstrumentationMiddleware from '../../../utils/telemetry/InstrumentationMiddleware';

const { SHIPPING_ADDR = '' } = process.env;

const handler = async ({ method, query }: NextApiRequest, res: NextApiResponse) => {
  switch (method) {
    case 'GET': {
      const { trackingId } = query;
      const response = await fetch(`${SHIPPING_ADDR}/shipping-status/${trackingId}`);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Shipping service error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const data = await response.json();

      return res.status(200).json(data);
    }

    default: {
      return res.status(405).send('');
    }
  }
};

export default InstrumentationMiddleware(handler);
