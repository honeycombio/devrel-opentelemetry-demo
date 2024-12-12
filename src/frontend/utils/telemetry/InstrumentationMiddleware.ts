// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { NextApiHandler } from 'next';
import { context, Exception, Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { SEMATTRS_HTTP_STATUS_CODE } from '@opentelemetry/semantic-conventions';
import { metrics } from '@opentelemetry/api';
import bunyan from 'bunyan';
import { logger as pinoLogger } from '../logger';

const meter = metrics.getMeter('frontend');
const requestCounter = meter.createCounter('app.frontend.requests');

const bunyanLogger = bunyan.createLogger({ name: 'instrumentationMiddleware', level: 'info' });
bunyanLogger.info({ message: 'bunyan logging started' });

type Options = {
  beNice: boolean;
};
const InstrumentationMiddleware = (handler: NextApiHandler, opts: Options = { beNice: false }): NextApiHandler => {
  return async (request, response) => {
    const startTime = Date.now();
    const { method, url = '' } = request;
    const [target] = url.split('?');

    const span = trace.getSpan(context.active()) as Span;

    const memoryUsage = recordMemoryUsage();
    span?.setAttributes({
      'memoryUsage.percentUsed': memoryUsage.heapUsed / memoryUsage.heapTotal,
    });
    // the pod is allocated 250Mb of memory, and it'll be OOMKilled if it goes over that.
    if (!opts.beNice && memoryUsage.rss > 200 * 1024 * 1024) {
      // if we're using over 200Mb of memory, be slow.
      // now... how do I sleep
      const randomSleep = Math.floor(Math.random() * 3000);
      await new Promise(resolve => setTimeout(resolve, randomSleep));
    }

    let httpStatus = 200;
    try {
      await runWithSpan(span, async () => handler(request, response));
      pinoLogger.info({
        message: 'Request handled',
        'log.source': 'pino',
        'http.method': method,
        'http.target': target,
        'http.status_code': httpStatus,
        duration_ms: Date.now() - startTime,
      });
      bunyanLogger.info({
        message: 'Request handled',
        'log.source': 'bunyan',
        'http.method': method,
        'http.target': target,
        'http.status_code': httpStatus,
        'log.severity': 'info',
        duration_ms: Date.now() - startTime,
      });
      httpStatus = response.statusCode;
    } catch (error) {
      pinoLogger.error({
        message: 'Request handled',
        'log.source': 'pino',
        'http.method': method,
        'http.target': target,
        'http.status_code': httpStatus,
        duration_ms: Date.now() - startTime,
      });
      bunyanLogger.error({
        message: 'Request handled',
        'log.source': 'bunyan',
        'http.method': method,
        'http.target': target,
        'http.status_code': httpStatus,
        'error.message': (error as Error).message,
        'log.severity': 'error',
        duration_ms: Date.now() - startTime,
      });
      span.recordException(error as Exception);
      span.setStatus({ code: SpanStatusCode.ERROR });
      httpStatus = 500;
      throw error;
    } finally {
      requestCounter.add(1, { method, target, status: httpStatus });
      span.setAttribute(SEMATTRS_HTTP_STATUS_CODE, httpStatus);
    }
  };
};

async function runWithSpan(parentSpan: Span, fn: () => Promise<unknown>) {
  const ctx = trace.setSpan(context.active(), parentSpan);
  return await context.with(ctx, fn);
}

function recordMemoryUsage() {
  const span = trace.getActiveSpan();
  // Log memory usage
  const memoryUsage = process.memoryUsage();
  span?.setAttributes({
    'memoryUsage.rss': memoryUsage.rss,
    'memoryUsage.heapTotal': memoryUsage.heapTotal,
    'memoryUsage.heapUsed': memoryUsage.heapUsed,
    'memoryUsage.external': memoryUsage.external,
  });
  return memoryUsage;
}

export default InstrumentationMiddleware;
