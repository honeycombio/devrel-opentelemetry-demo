// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Feature flag access for the payment service.
 *
 * One FlagdProvider is created for this process and registered once, at
 * startup. Charge and refund both read through it: they talk to the same
 * flagd, so a second provider would only mean a second connection to close
 * and reopen.
 *
 * Three rules hold everywhere below.
 *
 * 1. Reading a flag never throws. A flag we cannot read falls back to the
 *    caller's default, so a flagd outage can never fail a payment.
 *
 * 2. We do not swap providers to recover from a dropped connection. The flagd
 *    provider watches its own gRPC channel and re-listens on its own; handing
 *    OpenFeature a replacement closes the channel that reconnect loop lives
 *    on. A fresh provider is built only when the SDK declares the current one
 *    irrecoverable (FATAL), which in practice should never happen.
 *
 * 3. Registration happens exactly once, off the request path. Re-registering
 *    per request leaves the provider NOT_READY for a moment, and concurrent
 *    requests landing in that window get a thrown ProviderNotReadyError.
 */

const { OpenFeature, ProviderEvents, ProviderStatus } = require('@openfeature/server-sdk');
const { FlagdProvider } = require('@openfeature/flagd-provider');

const logger = require('./logger');

const PROVIDER_NAME = 'flagd';

// Backoff for rebuilding a provider the SDK has declared irrecoverable.
const REBUILD_MIN_DELAY_MS = 1_000;
const REBUILD_MAX_DELAY_MS = 30_000;

// Safe to build at module load: the client resolves whatever provider is
// registered at the moment of each evaluation, so it does not need one yet.
const client = OpenFeature.getClient();

let started = false;
let rebuildScheduled = false;
let rebuildAttempt = 0;

/**
 * Register the provider and start listening for its connection events.
 *
 * Resolves once registration has been attempted, whether or not flagd was
 * reachable. Callers should not block startup on it: the service is expected
 * to serve traffic on flag defaults while flagd is unavailable.
 */
async function start() {
  if (started) return;
  started = true;

  OpenFeature.addHandler(ProviderEvents.Ready, () => {
    logger.info('Feature flag provider connected.');
  });

  OpenFeature.addHandler(ProviderEvents.Error, ({ message }) => {
    // Expected whenever the flagd stream drops. The provider reconnects
    // itself, so there is nothing to do here but say so.
    logger.warn({ message }, 'Feature flag provider disconnected; it will reconnect.');
    rebuildIfIrrecoverable();
  });

  OpenFeature.addHandler(ProviderEvents.ConfigurationChanged, ({ flagsChanged }) => {
    logger.info({ flagsChanged }, 'Feature flag configuration changed.');
  });

  await register();
}

/** Tear the flagd connection down once, deliberately, on shutdown. */
async function shutdown() {
  try {
    await OpenFeature.close();
  } catch (err) {
    logger.warn({ err }, 'Error closing feature flag provider.');
  }
}

/**
 * Read a numeric flag. Returns defaultValue if it cannot be read, for any
 * reason, and annotates the span either way.
 */
async function getNumber(flagKey, defaultValue, span) {
  try {
    const details = await client.getNumberDetails(flagKey, defaultValue);

    if (details.errorCode) {
      // The SDK resolved to our default and told us why rather than throwing.
      recordFailure(span, flagKey, defaultValue, details.errorCode, details.errorMessage);
      return defaultValue;
    }

    recordEvaluation(span, flagKey, details);
    return details.value;
  } catch (err) {
    // Most failures come back as errorCode above, but ProviderNotReadyError
    // and ProviderFatalError are thrown, so this catch is load-bearing.
    recordFailure(span, flagKey, defaultValue, err.code ?? err.name, err.message);
    return defaultValue;
  }
}

function recordEvaluation(span, flagKey, details) {
  if (!span) return;

  const attributes = {
    'feature_flag.key': flagKey,
    'feature_flag.provider.name': PROVIDER_NAME,
    'feature_flag.result.value': details.value,
  };
  if (details.variant) {
    attributes['feature_flag.result.variant'] = details.variant;
  }
  if (details.reason) {
    // OpenFeature reports reasons in caps; semconv spells them lowercase.
    attributes['feature_flag.result.reason'] = details.reason.toLowerCase();
  }

  span.setAttributes(attributes);
}

function recordFailure(span, flagKey, defaultValue, errorType, errorMessage) {
  logger.warn({ flagKey, errorType, errorMessage }, 'Feature flag lookup failed; using default.');

  if (!span) return;

  span.setAttributes({
    'feature_flag.key': flagKey,
    'feature_flag.provider.name': PROVIDER_NAME,
    'feature_flag.result.value': defaultValue,
    'feature_flag.result.reason': 'error',
  });

  // An event, not an ERROR span status. We failed to read a flag; the payment
  // itself is fine. Marking the span as failed here would spend the payment
  // service's error budget on an outage in a system payment does not need.
  span.addEvent('feature_flag.evaluation_failed', {
    'feature_flag.key': flagKey,
    'error.type': errorType ?? 'unknown',
    'error.message': errorMessage ?? '',
  });
}

async function register() {
  try {
    await OpenFeature.setProviderAndWait(new FlagdProvider());
    rebuildAttempt = 0;
    logger.info('Feature flag provider registered.');
  } catch (err) {
    // flagd was unreachable. The provider has already armed its own reconnect,
    // so evaluations start succeeding once flagd comes back. Until then they
    // fall back to defaults, which is the whole point.
    logger.warn({ err }, 'Feature flag provider could not reach flagd; using defaults until it connects.');
  }
}

/**
 * The one case where a new provider instance is warranted: the SDK has marked
 * the current one FATAL, meaning it will not recover on its own. Every other
 * error is transient and belongs to the provider's own reconnect loop.
 */
function rebuildIfIrrecoverable() {
  if (rebuildScheduled) return;
  if (OpenFeature.getProviderStatus() !== ProviderStatus.FATAL) return;

  const delay = backoffDelay(rebuildAttempt++);
  rebuildScheduled = true;
  logger.warn({ delayMs: delay }, 'Feature flag provider is irrecoverable; rebuilding it.');

  setTimeout(async () => {
    try {
      await register();
    } finally {
      rebuildScheduled = false;
      rebuildIfIrrecoverable();
    }
  }, delay).unref();
}

function backoffDelay(attempt) {
  const capped = Math.min(REBUILD_MAX_DELAY_MS, REBUILD_MIN_DELAY_MS * 2 ** attempt);
  return Math.round(capped / 2 + Math.random() * (capped / 2));
}

module.exports = { start, shutdown, getNumber };
