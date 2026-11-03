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
 * Thrown for any non-2xx response. The message stays user-facing (the API's `error` field, which
 * CartDetail shows), and status/method/url go on the recorded exception (see recordException.ts).
 */
export class HttpError extends Error {
  readonly status: number;
  readonly method: string;
  readonly url: string;

  constructor(message: string, status: number, method: string, url: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.method = method;
    this.url = url;
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
  let data;
  try {
    data = responseText ? JSON.parse(responseText) : undefined;
  } catch (err) {
    if (response.ok) {
      throw err;
    }
    data = undefined;
  }

  if (!response.ok) {
    throw new HttpError(data?.error || `Request failed with status ${response.status}`, response.status, method, url);
  }

  return data as T;
};

export default request;
