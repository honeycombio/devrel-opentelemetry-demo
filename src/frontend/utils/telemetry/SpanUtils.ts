import { context, trace } from "@opentelemetry/api";
import { Attributes, HrTime } from "@opentelemetry/api";
import { recordExceptionOrErrorMessage } from './recordException';

export async function tracedQuery<T>(
  name: string,
  fn: () => Promise<T>,
  tracerName = 'default'
): Promise<T> {
  const tracer = trace.getTracer(tracerName);
  const span = tracer.startSpan(name);

  return context.with(trace.setSpan(context.active(), span), async () => {
    let endTime: HrTime | undefined;
    try {
      const result = await fn();
      return result;
    } catch (err) {
      endTime = recordExceptionOrErrorMessage(err, span);
      return Promise.reject("query failed")
    } finally {
      // On error, end at the exception's timestamp so the log is never after the span.
      span.end(endTime);
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
      let endTime: HrTime | undefined;
      try {
        const result = await fn(variables);
        return result;
      } catch (err: Error | unknown) {
        endTime = recordExceptionOrErrorMessage(err, span);
        throw err;
      } finally {
        // On error, end at the exception's timestamp so the log is never after the span.
        span.end(endTime);
      }
    });
  };
}
