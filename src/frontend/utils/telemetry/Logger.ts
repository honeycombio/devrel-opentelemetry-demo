// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import * as bunyan from 'bunyan';

// Create logger instance with structured configuration
const logger = bunyan.createLogger({
  name: 'api-gateway',
  level: 'info',
  // Add custom serializers for common objects
  serializers: {
    req: bunyan.stdSerializers.req,
    res: bunyan.stdSerializers.res,
    err: bunyan.stdSerializers.err,
  },
});

export default logger;