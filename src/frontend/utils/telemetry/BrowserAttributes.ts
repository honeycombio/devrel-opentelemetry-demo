// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

// Browser, screen, page and entry-page attributes. The upstream browser-detector and
// DocumentSpanProcessor do not provide these, so we set them here (hand-written, no UA-parsing library).

import { Attributes, Context } from "@opentelemetry/api";
import { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace";

const parseUserAgent = (ua: string) => {
    // Order matters: Edge and Opera also say "Chrome"; Chrome also says "Safari".
    const rules: [string, RegExp][] = [
        ['Edge', /Edg(?:e|A|iOS)?\/([\d.]+)/],
        ['Opera', /OPR\/([\d.]+)/],
        ['Firefox', /(?:Firefox|FxiOS)\/([\d.]+)/],
        ['Chrome', /(?:Chrome|CriOS)\/([\d.]+)/],
        ['Safari', /Version\/([\d.]+).*Safari/],
    ];
    for (const [name, re] of rules) {
        const m = ua.match(re);
        if (m) return { name, version: m[1] };
    }
    return { name: 'Unknown', version: 'Unknown' };
};

const deviceType = (ua: string) => {
    if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'tablet';
    if (/Mobi|iPhone|iPod|Android/i.test(ua)) return 'mobile';
    return 'desktop';
};

// Resource attributes: fixed for the life of the page.
export const browserResourceAttributes = (): Attributes => {
    const ua = navigator.userAgent;
    const { name, version } = parseUserAgent(ua);
    const entry = window.location;
    return {
        'browser.name': name,
        'browser.version': version,
        'device.type': deviceType(ua),
        'screen.width': window.screen.width,
        'screen.height': window.screen.height,
        'screen.size': `${window.screen.width}x${window.screen.height}`,
        'entry_page.url': entry.href,
        'entry_page.path': entry.pathname,
        'entry_page.search': entry.search,
        'entry_page.hash': entry.hash,
        'entry_page.hostname': entry.hostname,
        'entry_page.referrer': document.referrer,
    };
};

// Span attributes: change as the user navigates and resizes.
export class BrowserAttributesSpanProcessor implements SpanProcessor {
    forceFlush(): Promise<void> {
        return Promise.resolve();
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    onStart(span: Span, parentContext: Context): void {
        const l = window.location;
        span.setAttributes({
            'browser.width': window.innerWidth,
            'browser.height': window.innerHeight,
            'browser.page.visibility': document.visibilityState,
            'page.url': l.href,
            'page.route': l.pathname,
            'page.hash': l.hash,
            'page.hostname': l.hostname,
            'page.search': l.search,
            'url.path': l.pathname,
        });
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-function
    onEnd(span: ReadableSpan): void {}

    shutdown(): Promise<void> {
        return Promise.resolve();
    }
}
