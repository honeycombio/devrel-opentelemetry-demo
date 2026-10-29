import {
    HrTime,
    Span,
    SpanStatusCode,
    context,
    trace
} from '@opentelemetry/api';
import { hrTime } from '@opentelemetry/core';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';

/**
 * Records an exception as a log record tied to the given span, so the log
 * carries trace_id and span_id. Marks the span as errored.
 *
 * Blame React Query for the varying types of "errors" that can be returned
 *
 * @param {Error} error - The error object to record.
 * @param {Span} span - The span to link the log record to
 * @returns {HrTime} The timestamp given to the log record. Pass it to span.end() so
 *   the exception never lands after the end of its span.
 */
export function recordExceptionOrErrorMessage(
    error: Error | string | unknown,
    span: Span
): HrTime {
    span.setStatus({code: SpanStatusCode.ERROR});
    // Same clock as span start/end, so the event lands inside the span bar.
    const timestamp = hrTime();

    let attributes: Record<string, string | undefined>;
    if (error instanceof Error) {
        attributes = {
            'exception.type': error.name,
            'exception.message': error.message,
            'exception.stacktrace': error.stack,
        };
    } else if (typeof error === 'string') {
        attributes = { 'exception.message': error };
    } else {
        attributes = { 'exception.message': 'Unknown error' };
    }

    logs.getLogger('exceptions').emit({
        eventName: 'exception',
        timestamp,
        severityNumber: SeverityNumber.ERROR,
        context: trace.setSpan(context.active(), span),
        attributes,
    });

    return timestamp;
}
