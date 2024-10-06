// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { NextApiHandler } from 'next';
import {context, Exception, Span, SpanStatusCode, trace} from '@opentelemetry/api';
import { SEMATTRS_HTTP_STATUS_CODE } from '@opentelemetry/semantic-conventions';
import { metrics } from '@opentelemetry/api';
import { logger } from '../logger';

const meter = metrics.getMeter('frontend');
const requestCounter = meter.createCounter('app.frontend.requests');

type Options = {
  beNice: boolean;
}
const InstrumentationMiddleware = (handler: NextApiHandler, opts: Options = { beNice: false }): NextApiHandler => {
  return async (request, response) => {
    const {method, url = ''} = request;
    const [target] = url.split('?');

    const span = trace.getSpan(context.active()) as Span;

    const memoryUsage = recordMemoryUsage();
    span?.setAttributes({
      'memoryUsage.percentUsed': memoryUsage.heapUsed / memoryUsage.heapTotal,
    });
    // the pod is allocated 250Mb of memory, and it'll be OOMKilled if it goes over that.
    if (!opts.beNice && memoryUsage.rss > 200 * 1024 * 1024) { // if we're using over 200Mb of memory, be slow.
      // now... how do I sleep
      const randomSleep = Math.floor(Math.random() * 1000);
      await new Promise((resolve) => setTimeout(resolve, randomSleep));
    }

    let httpStatus = 200;
    try {
      await runWithSpan(span, async () => handler(request, response));
      logger.info('Request handled', { 'http.method': method, 'url.path': target, 'http.status_code': httpStatus });
      httpStatus = response.statusCode;
    } catch (error) {
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
  const span = trace.getActiveSpan()
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
