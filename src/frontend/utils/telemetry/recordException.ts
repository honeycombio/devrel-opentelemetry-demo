import {
    Span,
    SpanStatusCode
} from '@opentelemetry/api';
import {recordException} from '@honeycombio/opentelemetry-web';


/**
 * Records an exception as a span in the OpenTelemetry tracer.
 *
 * Blame React Query for the varying types of "errors" that can be returned
 *
 * @param {Error} error - The error object to record.
 * @param {Attributes} [attributes={}] - Additional attributes to add to the span.
 * @param {Span} span - The span to record the error from
 */

const isError = (e) => {
    return e &&
        e.stack &&
        e.message &&
        typeof e.stack === 'string' &&
        typeof e.message === 'string';
};
export function recordExceptionOrErrorMessage(
    error: Error | string | unknown,
    span: Span
) {

    if (error instanceof Error) {
      // Honeycomb helper does both the error status on span AND record exception from this HC helper
      recordException(error as Error, {})
      // another odd error from Tanstack Query - just a message string
    } else if (typeof error === 'string') {
        span.addEvent('error', { 'error.message': error })
        span.setStatus({code: SpanStatusCode.ERROR});
    // or if we can't tell the type then just punt
    } else {
        span.addEvent('error', { 'error message' : 'Unknown error'});
    }   span.setStatus({code: SpanStatusCode.ERROR});

}
