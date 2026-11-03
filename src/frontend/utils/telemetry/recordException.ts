import { Attributes, context, logs, SeverityNumber, Span, SpanStatusCode, trace } from '@opentelemetry/api';
import {
  ATTR_EXCEPTION_MESSAGE,
  ATTR_EXCEPTION_STACKTRACE,
  ATTR_EXCEPTION_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_URL_PATH,
} from '@opentelemetry/semantic-conventions';
import { HttpError } from '../Request';

const logger = logs.getLogger('frontend-exceptions');

/**
 * Records a handled error on the span that wraps the failed call:
 *  - sets the span status to ERROR,
 *  - emits an `exception` log record in the span's context, the same shape that
 *    browser-instrumentation's ErrorsInstrumentation emits for uncaught errors. That module
 *    never sees these errors, because the caller catches them.
 *
 * Blame React Query for the varying types of "errors" that can be returned.
 */
export function recordExceptionOrErrorMessage(error: Error | string | unknown, span: Span) {
  span.setStatus({ code: SpanStatusCode.ERROR });

  let attributes: Attributes;
  if (error instanceof Error) {
    attributes = {
      [ATTR_EXCEPTION_TYPE]: error.name,
      [ATTR_EXCEPTION_MESSAGE]: error.message,
      [ATTR_EXCEPTION_STACKTRACE]: error.stack,
    };
    if (error instanceof HttpError) {
      const http = {
        [ATTR_HTTP_RESPONSE_STATUS_CODE]: error.status,
        [ATTR_HTTP_REQUEST_METHOD]: error.method,
        [ATTR_URL_PATH]: error.url,
      };
      span.setAttributes(http);
      Object.assign(attributes, http);
    }
  } else {
    const message = typeof error === 'string' ? error : 'Unknown error';
    attributes = { [ATTR_EXCEPTION_MESSAGE]: message };
  }

  logger.emit({
    eventName: 'exception',
    severityNumber: SeverityNumber.ERROR,
    severityText: 'ERROR',
    context: trace.setSpan(context.active(), span),
    attributes,
  });
}
