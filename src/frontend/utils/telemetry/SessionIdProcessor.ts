// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { Context } from "@opentelemetry/api";
import { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-web";
import SessionGateway from "../../gateways/Session.gateway";
import { AttributeNames } from "../enums/AttributeNames";

export class SessionIdProcessor implements SpanProcessor {
    forceFlush(): Promise<void> {
        return Promise.resolve();
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    onStart(span: Span, parentContext: Context): void {
        // Read the session each time: the corporate login can change while the page is open.
        const { userId, corporateUserId, company } = SessionGateway.getSession();
        span.setAttribute(AttributeNames.SESSION_ID, userId);
        if (corporateUserId && company) {
            span.setAttribute(AttributeNames.CORPORATE_USER_ID, corporateUserId);
            span.setAttribute(AttributeNames.COMPANY, company);
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-function
    onEnd(span: ReadableSpan): void {}

    shutdown(): Promise<void> {
        return Promise.resolve();
    }
}
