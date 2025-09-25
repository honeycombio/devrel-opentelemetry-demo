import { context, trace } from "@opentelemetry/api";
import { Attributes} from "@opentelemetry/api";
import { recordExceptionOrErrorMessage } from './recordException';

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
      recordExceptionOrErrorMessage(err, span);
      return Promise.reject("query failed")
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
      } catch (err: Error | unknown) {
          recordExceptionOrErrorMessage(err, span);
        throw err;
      } finally {
        span.end();
      }
    });
  };
}
