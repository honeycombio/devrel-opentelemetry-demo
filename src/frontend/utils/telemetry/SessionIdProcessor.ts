// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { Attributes, Context } from "@opentelemetry/api";
import { LogRecordProcessor, ReadWriteLogRecord } from "@opentelemetry/sdk-logs";
import { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace";
import SessionGateway from "../../gateways/Session.gateway";
import { AttributeNames } from "../enums/AttributeNames";

// Read the session each time: the corporate login can change while the page is open.
function getSessionAttributes(): Attributes {
    const { userId, corporateUserId, company } = SessionGateway.getSession();
    const attributes: Attributes = {
        [AttributeNames.SESSION_ID]: userId,
        [AttributeNames.ENDUSER_ID]: userId,
    };
    if (corporateUserId && company) {
        attributes[AttributeNames.CORPORATE_USER_ID] = corporateUserId;
        attributes[AttributeNames.COMPANY] = company;
    }
    return attributes;
}

export class SessionIdProcessor implements SpanProcessor {
    forceFlush(): Promise<void> {
        return Promise.resolve();
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    onStart(span: Span, parentContext: Context): void {
        span.setAttributes(getSessionAttributes());
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-function
    onEnd(span: ReadableSpan): void {}

    shutdown(): Promise<void> {
        return Promise.resolve();
    }
}

// The browser-instrumentation events (navigation, user-action, web-vitals, errors, ...) are
// log records, not spans. Put the same session attributes on them so you can group by session.
export class SessionIdLogRecordProcessor implements LogRecordProcessor {
    forceFlush(): Promise<void> {
        return Promise.resolve();
    }

    onEmit(logRecord: ReadWriteLogRecord): void {
        for (const [key, value] of Object.entries(getSessionAttributes())) {
            logRecord.setAttribute(key, value);
        }
    }

    shutdown(): Promise<void> {
        return Promise.resolve();
    }
}
