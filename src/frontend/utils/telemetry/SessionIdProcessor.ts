// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import { Context } from "@opentelemetry/api";
import { SdkLogRecord, LogRecordProcessor } from "@opentelemetry/sdk-logs";
import { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace";
import SessionGateway from "../../gateways/Session.gateway";
import { AttributeNames } from "../enums/AttributeNames";

// NOTE: this demo keeps its own session source (SessionGateway) because it also carries the
// corporate login (app.company, app.corporate_user.id). In a real-world app, prefer the upstream
// createSessionSpanProcessor / createSessionLogRecordProcessor from '@opentelemetry/browser-sdk/session',
// which manage the session id, expiry and storage for you.
const sessionAttributes = () => {
    // Read the session each time: the corporate login can change while the page is open.
    const { userId, corporateUserId, company } = SessionGateway.getSession();
    return {
        [AttributeNames.SESSION_ID]: userId,
        ...(corporateUserId && company
            ? { [AttributeNames.CORPORATE_USER_ID]: corporateUserId, [AttributeNames.COMPANY]: company }
            : {}),
    };
};

export class SessionIdProcessor implements SpanProcessor {
    forceFlush(): Promise<void> {
        return Promise.resolve();
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    onStart(span: Span, parentContext: Context): void {
        span.setAttributes(sessionAttributes());
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-function
    onEnd(span: ReadableSpan): void {}

    shutdown(): Promise<void> {
        return Promise.resolve();
    }
}

// Same attributes on log records (web vitals, exceptions), so they join to spans by session.
export class SessionIdLogRecordProcessor implements LogRecordProcessor {
    onEmit(logRecord: SdkLogRecord): void {
        logRecord.setAttributes(sessionAttributes());
    }

    forceFlush(): Promise<void> {
        return Promise.resolve();
    }

    shutdown(): Promise<void> {
        return Promise.resolve();
    }
}
