import {
    Span,
    SpanStatusCode
} from '@opentelemetry/api';

/**
 * Records an exception as a span in the OpenTelemetry tracer.
 *
 * Blame React Query for the varying types of "errors" that can be returned
 *
 * @param {Error} error - The error object to record.
 * @param {Attributes} [attributes={}] - Additional attributes to add to the span.
 * @param {Span} span - The span to record the error from
 */
export function recordExceptionOrErrorMessage(
    error: Error | string | unknown,
    span: Span
) {
    span.setStatus({code: SpanStatusCode.ERROR});
    if (error instanceof Error) {
        span.recordException(error);
    } else if (typeof error === 'string') {
        span.addEvent('error', { 'error.message': error })
    } else {
        span.addEvent('error', { 'error message' : 'Unknown error'});
    }
}
