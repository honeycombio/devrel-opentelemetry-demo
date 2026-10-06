// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

interface IRequestParams {
  url: string;
  body?: object;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  queryParams?: Record<string, any>;
  headers?: Record<string, string>;
}

/**
 * Thrown for any non-2xx response, so recorded exceptions carry the HTTP status
 * and target instead of a JSON.parse error on a plain-text error body.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly method: string;
  readonly url: string;
  readonly body: string;

  constructor(status: number, statusText: string, method: string, url: string, body: string) {
    const detail = body ? `: ${body.slice(0, 200)}` : '';
    super(`HTTP ${status} ${statusText} on ${method} ${url}${detail}`);
    this.name = 'HttpError';
    this.status = status;
    this.method = method;
    this.url = url;
    this.body = body;
  }
}

const request = async <T>({
  url = '',
  method = 'GET',
  body,
  queryParams = {},
  headers = {
    'content-type': 'application/json',
  },
}: IRequestParams): Promise<T> => {
  const response = await fetch(`${url}?${new URLSearchParams(queryParams).toString()}`, {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers,
  });

  const responseText = await response.text();

  if (!response.ok) throw new HttpError(response.status, response.statusText, method, url, responseText);

  if (!!responseText) return JSON.parse(responseText);

  return undefined as unknown as T;
};

export default request;
