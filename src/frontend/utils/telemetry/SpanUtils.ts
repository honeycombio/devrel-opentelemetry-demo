import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { Attributes, Span } from "@opentelemetry/api";

export async function tracedQuery<T>(
  name: string,
  fn: () => Promise<T>,
  tracerName = 'default'
): Promise<T> {
  const tracer = trace.getTracer(tracerName);
  const span = tracer.startSpan(name);

  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const result = await fn();
      return result;
    } catch (err) {
      recordExceptionAndMarkSpanError(err, span);
      throw err;
    } finally {
      span.end();
    }
  });
}

export function spanAttributesForRpc(
  service: string,
  method: string,
  component?: string
): Attributes {
  return {
    'rpc.service': service,
    'rpc.method': method,
    ...(component ? { 'component': component } : {}),
  };
}

export function tracedMutation<TVariables, TResult>(
  name: string,
  fn: (variables: TVariables) => Promise<TResult>,
  tracerName = 'default',
  attributes: Attributes = {}
) {
  const tracer = trace.getTracer(tracerName);
  return async (variables: TVariables) => {
    const span = tracer.startSpan(name, { attributes });

    return context.with(trace.setSpan(context.active(), span), async () => {
      try {
        const result = await fn(variables);
        return result;
      } catch (err) {
        recordExceptionAndMarkSpanError(err, span);
        throw err;
      } finally {
        span.end();
      }
    });
  };
}

export function recordExceptionAndMarkSpanError(err: unknown, span: Span | undefined) {
  if (err instanceof Error) {
     span?.recordException(err);
     span?.addEvent('error', { message: err.message });
     span?.setStatus({
       code: SpanStatusCode.ERROR,
       message: err.message,
     });
    } else {
    // fallback if it's not an Error (e.g. string or object)
    span?.recordException({
      name: 'UnknownError',
      message: String(err),
    });
    span?.addEvent('error', { message: String(err) });
    span?.setStatus({
      code: SpanStatusCode.ERROR,
      message: 'Unknown error',
    });
  }
}
