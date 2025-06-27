// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { NextApiHandler } from 'next';
import {context, Exception, Span, SpanStatusCode, trace} from '@opentelemetry/api';
import { SemanticAttributes } from '@opentelemetry/semantic-conventions';
import { metrics } from '@opentelemetry/api';

import logger from './Logger';

const meter = metrics.getMeter('frontend');
const requestCounter = meter.createCounter('app.frontend.requests');

const InstrumentationMiddleware = (handler: NextApiHandler): NextApiHandler => {
  return async (request, response) => {
    const {method, url = ''} = request;
    const [target] = url.split('?');
    const startTime = Date.now();

    const span = trace.getSpan(context.active()) as Span;

    // Log request initiation
    logger.info({
      req: request,
      'app.request.method': method,
      'app.request.target': target,
      'app.request.user_agent': request.headers['user-agent'],
    }, 'API request started');

    let httpStatus = 200;
    try {
      await runWithSpan(span, async () => handler(request, response));
      httpStatus = response.statusCode;
      
      // Log successful response
      const duration = Date.now() - startTime;
      logger.info({
        'app.response.status_code': httpStatus,
        'app.response.duration_ms': duration,
        'app.request.method': method,
        'app.request.target': target,
      }, 'API request completed successfully');
      
    } catch (error) {
      span.recordException(error as Exception);
      span.setStatus({ code: SpanStatusCode.ERROR });
      httpStatus = 500;
      
      // Log error with context
      const duration = Date.now() - startTime;
      logger.error({
        err: error,
        'app.response.status_code': httpStatus,
        'app.response.duration_ms': duration,
        'app.request.method': method,
        'app.request.target': target,
      }, 'API request failed');
      
      throw error;
    } finally {
      requestCounter.add(1, { method, target, status: httpStatus });
      span.setAttribute(SemanticAttributes.HTTP_STATUS_CODE, httpStatus);
    }
  };
};

async function runWithSpan(parentSpan: Span, fn: () => Promise<unknown>) {
  const ctx = trace.setSpan(context.active(), parentSpan);
  return await context.with(ctx, fn);
}

export default InstrumentationMiddleware;
