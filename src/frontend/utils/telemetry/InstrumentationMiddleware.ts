// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { NextApiHandler } from 'next';
import { context, Exception, Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { SEMATTRS_HTTP_STATUS_CODE } from '@opentelemetry/semantic-conventions';
import { metrics } from '@opentelemetry/api';
import { logger } from '../logger';
import logsapi from '@opentelemetry/api-logs';

const meter = metrics.getMeter('frontend');
const requestCounter = meter.createCounter('app.frontend.requests');

const otelLogger = logsapi.logs.getLogger('instrumentationMiddleware');

// logging a log record in a log appender
otelLogger.emit({ severityNumber: logsapi.SeverityNumber.INFO, body: 'stuff goes here' });
console.log('Jess was here 1');

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
      otelLogger.emit({
        severityNumber: logsapi.SeverityNumber.INFO,
        body: 'Request handled',
        attributes: {
          'log.source': 'otelLogger.emit',
          'http.method': method,
          'http.target': target,
          'http.status_code': httpStatus,
          duration_ms: Date.now() - startTime,
        },
      });
      logger.info('Request handled', {
        'http.method': method,
        'http.target': target,
        'http.status_code': httpStatus,
        duration_ms: Date.now() - startTime,
      });
      httpStatus = response.statusCode;
    } catch (error) {
      otelLogger.emit({
        severityNumber: logsapi.SeverityNumber.ERROR,
        body: 'Request handled',
        attributes: {
          'log.source': 'otelLogger.emit',
          'http.method': method,
          'http.target': target,
          'http.status_code': httpStatus,
          duration_ms: Date.now() - startTime,
        },
      });
      logger.error('Request handled', {
        'http.method': method,
        'http.target': target,
        'http.status_code': httpStatus,
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
