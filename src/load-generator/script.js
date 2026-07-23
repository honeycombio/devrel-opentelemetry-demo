// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import http from 'k6/http'
import { sleep } from 'k6'
import { browser } from 'k6/browser'
import { Tracer } from 'k6/x/otel'

const BASE_URL = __ENV.K6_TARGET_URL || 'http://frontend-proxy:8080'
const FLAGD_HOST = __ENV.FLAGD_HOST || 'flagd'
const FLAGD_OFREP_PORT = __ENV.FLAGD_OFREP_PORT || '8016'

// The HTTP scenario's VU count is read from LOAD_GENERATOR_VUS rather than
// k6's own K6_VUS, since a K6_VUS env var makes k6 discard this script's
// scenarios config entirely in favor of an implicit single scenario (see
// README.md). The browser scenario runs a single headless browser session
// alongside the HTTP traffic; it stays opt-in via K6_BROWSER_ENABLED.
const browserEnabled = (__ENV.K6_BROWSER_ENABLED || '').toLowerCase() === 'true'

// Agent (Bedrock-hitting) loadgen tasks are opt-in. Locals share one AWS
// account; without this guard every developer's namespace would hammer
// Bedrock concurrently, making cost and CloudWatch metrics unattributable.
// Set AGENT_LOAD_ENABLED=true in the deployed environment only.
const agentLoadEnabled = ['true', 'yes', 'on', '1'].includes((__ENV.AGENT_LOAD_ENABLED || '').toLowerCase())

export const options = {
    scenarios: {
        load: {
            executor: 'constant-vus',
            exec: 'httpScenario',
            vus: parseInt(__ENV.LOAD_GENERATOR_VUS || '10'),
            duration: __ENV.K6_DURATION || '9999h',
        },
        ...(browserEnabled ? {
            browser: {
                executor: 'constant-vus',
                exec: 'browserScenario',
                vus: 1,
                duration: __ENV.K6_DURATION || '9999h',
                options: {
                    browser: {
                        type: 'chromium',
                        headless: true,
                        // executablePath/args come from env vars, not this field - see README.md.
                    },
                },
            },
        } : {}),
    },
}

const products = [
    '0PUK6V6EV0', '1YMWWN1N4O', '2ZYFJ3GM2N', '66VCHSJNUP', '6E92ZMYYFZ',
    '9SIQT8TOJO', 'L9ECAV7KIM', 'LS4PSXUNUM', 'OLJCESPC7Z', 'HQTGWGPNH4',
]

const categories = ['binoculars', 'telescopes', 'accessories', 'assembly', 'travel', 'books', null]

const people = JSON.parse(open('./people.json'))

// ---- store-chat traffic (ported from locustfile.py) -------------------------

// Per-VU cooldown on the AI tasks. With sleep(1,10) between iterations and the
// current weighted task mix, a weight-1 task is naturally selected once every
// ~3 minutes per VU -- so this cooldown only does real work above that
// threshold. 600s gives roughly one AI invocation per VU every ten minutes,
// which is what dominates Bedrock spend in this demo.
const AI_TASK_MIN_INTERVAL_SECONDS = 600
const PASTED_EMAIL_TASK_MIN_INTERVAL_SECONDS = 600 // ~10 min/VU keeps this rare

// Multi-turn scripts for store-chat. Each entry is a list of 2-4 user messages
// a real customer might send in one session. The agent keeps conversation
// state keyed by sessionId, so follow-ups inherit context from earlier turns.
const STORE_CHAT_CONVERSATIONS = [
    ["What's the status of my most recent order?", 'When will it arrive?', 'Thanks!'],
    ['Has my package shipped yet?', 'Can you give me the tracking number?'],
    [
        'I need to return something.',
        'Yes, please refund my most recent order — it arrived damaged.',
        'When will the money be back on my card?',
    ],
    ['Can you look up my recent orders?', "Refund the telescope, it's the wrong model."],
    [
        "My order hasn't arrived yet and it's been a week.",
        'Can you check the shipping status?',
        "If it's lost, please refund it.",
    ],
    ['I bought something last week, what was it?', 'How much did I pay for it?'],
]

// Small fixed pool of customer emails used by the refund-backup task. Reusing
// the same emails (instead of a fresh one per session) means orders accumulate
// against each one across loadgen runs, so lookup_orders ends up returning a
// steadily-growing JSON blob. Used only when the storechatRefundBackupOrders
// flag is on.
const BACKUP_REFUND_EMAILS = [
    'loyal-vip-1@aurelia.honeydemo.io',
    'loyal-vip-2@aurelia.honeydemo.io',
    'loyal-vip-3@aurelia.honeydemo.io',
]

// A realistic-looking forwarded email thread a frustrated customer might paste
// into a chat: multi-level reply chain about a missing delivery, with the
// boilerplate confidential-disclosure footer repeated on every reply. Repeated
// 8x to mimic a deeply-escalated support thread (and to make the resulting
// token spike unmistakable). The store-chat /chat endpoint does not bound
// `question` size before sending it to the model, so a single turn containing
// this blob inflates `gen_ai.usage.input_tokens` for that one conversation by
// an order of magnitude versus a normal session.
const PASTED_EMAIL_THREAD = `---------- Forwarded message ---------
From: Aurelia Customer Support <support@aurelia.honeydemo.io>
Date: Wed, May 13, 2026 at 4:32 PM
Subject: Re: Re: Re: Re: Order ORD-489201 — still no delivery
To: <me>

Hello,

Thank you for your patience. We have checked with our shipping partner and they
have confirmed that the package was scanned at the Memphis distribution center
on May 7. Unfortunately we have not received any further tracking updates since
then. We have opened an internal ticket (INC-2026-44811) with the carrier and a
member of our logistics team will follow up within 3-5 business days.

We understand the frustration that comes with a delayed shipment and we want to
assure you that we are doing everything we can on our end to locate the package.
If we are unable to confirm delivery within the next 7 business days we will
reship the order at no cost to you, or process a full refund — whichever you
prefer.

Kind regards,
Priya
Aurelia Customer Support — Tier 2

CONFIDENTIAL: This email and any attachments are confidential and intended
solely for the use of the individual or entity to whom they are addressed. If
you have received this email in error please notify the sender by reply email
and delete the message and any attachments from your system. Aurelia Holdings
Inc., its subsidiaries, and affiliates accept no liability for any damage
caused by any virus transmitted by this email. The views expressed in this
email are those of the sender and do not necessarily reflect those of Aurelia
Holdings Inc. Aurelia Holdings Inc. is registered in the State of Delaware,
registration number 7104228, registered office 1209 Orange Street, Wilmington
DE 19801. This communication may contain information that is proprietary,
privileged, or otherwise legally protected from disclosure. Any unauthorized
review, use, disclosure, dissemination, distribution, or copying of this
communication or its contents is strictly prohibited.

---------- Forwarded message ---------
From: <me>
Date: Mon, May 11, 2026 at 9:12 AM
Subject: Re: Re: Re: Order ORD-489201 — still no delivery
To: Aurelia Customer Support <support@aurelia.honeydemo.io>

Hi Priya,

It's now been a full week since the last update telling me the package was "in
transit". The tracking link you sent me hasn't moved since May 4. I've called
the shipping carrier directly and they told me they have no record of the
package leaving the Memphis facility. Can you please confirm with your
warehouse that the package actually shipped, and provide me with a fresh
tracking number if it didn't?

I bought this telescope as a birthday present for my partner. The birthday is
on May 22. If it's not going to arrive by then I'd rather just have a refund so
I can buy something locally — please let me know which option you can offer.

Thanks,
<me>

---------- Forwarded message ---------
From: Aurelia Customer Support <support@aurelia.honeydemo.io>
Date: Mon, May 4, 2026 at 2:48 PM
Subject: Re: Re: Order ORD-489201 — still no delivery
To: <me>

Hello,

Thank you for reaching out again. I can see from our records that your order
shipped on April 28 via our standard ground shipping partner, with an estimated
delivery window of May 2-6. The tracking number is 1Z999AA10123456784. Our
records show the package is currently in transit and should arrive within the
original estimated window.

If you do not receive the package by May 6, please reply to this email and we
will escalate to our shipping investigations team.

Kind regards,
Marcus
Aurelia Customer Support — Tier 1

CONFIDENTIAL: This email and any attachments are confidential and intended
solely for the use of the individual or entity to whom they are addressed. If
you have received this email in error please notify the sender by reply email
and delete the message and any attachments from your system. Aurelia Holdings
Inc., its subsidiaries, and affiliates accept no liability for any damage
caused by any virus transmitted by this email.

---------- Forwarded message ---------
From: <me>
Date: Mon, May 4, 2026 at 8:15 AM
Subject: Re: Order ORD-489201 — still no delivery
To: Aurelia Customer Support <support@aurelia.honeydemo.io>

Hello,

I placed order ORD-489201 on April 24 and have not received any shipping
confirmation since then. The order confirmation page said it should arrive
within 5-7 business days. It is now day 9 (excluding the weekend). Could
someone please look into where my order is?

Thanks,
<me>

---------- Forwarded message ---------
From: Aurelia Order Confirmation <noreply@aurelia.honeydemo.io>
Date: Sat, Apr 24, 2026 at 11:03 AM
Subject: Your Aurelia order ORD-489201 has been received
To: <me>

Thank you for your order!

Order number: ORD-489201
Order date: April 24, 2026
Estimated delivery: April 30 - May 6, 2026

Items:
  1 × Roof Prism Binoculars (8x42) ........................... $129.00
  1 × Lyra-Reflex 8-inch Dobsonian Telescope ................. $749.00
  1 × Plossl Eyepiece Set (4 piece) ..........................  $89.00

Subtotal: ................................................... $967.00
Shipping: ................................................... $  0.00 (free)
Tax: ........................................................ $ 58.02
Total: ...................................................... $1025.02

We'll send another email when your order ships. You can also check the status
of your order any time by logging into your account at aurelia.honeydemo.io.

CONFIDENTIAL: This email and any attachments are confidential and intended
solely for the use of the individual or entity to whom they are addressed. If
you have received this email in error please notify the sender by reply email
and delete the message and any attachments from your system. Aurelia Holdings
Inc., its subsidiaries, and affiliates accept no liability for any damage
caused by any virus transmitted by this email. The views expressed in this
email are those of the sender and do not necessarily reflect those of Aurelia
Holdings Inc. This message is sent from an unmonitored mailbox; replies will
not be read or answered.
`.repeat(8)

const tracer = new Tracer()

// ---- helpers ----------------------------------------------------------------

// Uses a Uint8Array rather than Uint32Array(1): k6's crypto.getRandomValues
// only randomizes `buf.length` bytes, not `buf.byteLength`, so a Uint32Array(1)
// gets just 1 random byte with the upper 3 left as zero.
function cryptoRandom() {
    const buf = new Uint8Array(4)
    crypto.getRandomValues(buf)
    const val = ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0
    return val / 0x100000000
}

function randomChoice(arr) {
    return arr[Math.floor(cryptoRandom() * arr.length)]
}

function uuid4() {
    return crypto.randomUUID()
}

// getFlagdValue mirrors Locust's TracingHook: each flag evaluation gets its
// own OTel span so flag-driven behaviour is visible in traces.
function getFlagdValue(flagName) {
    const span = tracer.startSpan('feature_flag.evaluate', { 'feature_flag.key': flagName })
    const res = http.post(
        `http://${FLAGD_HOST}:${FLAGD_OFREP_PORT}/ofrep/v1/evaluate/flags/${flagName}`,
        JSON.stringify({}),
        { headers: otelHeaders({ 'Content-Type': 'application/json' }), tags: { flagd: 'true' } }
    )
    let value = 0
    if (res.status === 200) {
        value = JSON.parse(res.body).value || 0
    }
    span.log(`Feature flag ${flagName} evaluated to ${value}`)
    span.end()
    return value
}

// Builds outbound HTTP headers carrying baggage only -- deliberately no
// traceparent. k6 still emits its own spans (tracer.startSpan below), but
// downstream services see no incoming trace context and start fresh root
// traces, matching how real edge traffic looks. Baggage still propagates so
// synthetic_request=true survives (ported from locustfile.py's
// set_global_textmap(W3CBaggagePropagator())).
function otelHeaders(extra) {
    return Object.assign(
        { baggage: `synthetic_request=true,session.id=${sessionId}` },
        extra
    )
}

// ---- per-VU session state ---------------------------------------------------

let sessionId = null
let lastStoreChatRun = 0
let lastPastedEmailRun = 0
let lastRefundBackupRun = 0

function onStart() {
    sessionId = uuid4()
    const span = tracer.startSpan('user_session_start')
    span.log(`Starting user session: ${sessionId}`)
    http.get(`${BASE_URL}/`, { headers: otelHeaders() })
    span.end()
}

// ---- tasks ------------------------------------------------------------------

function index() {
    const span = tracer.startSpan('user_index')
    span.log('User accessing index page')
    http.get(`${BASE_URL}/`, { headers: otelHeaders() })
    span.end()
}

function browseProduct() {
    const product = randomChoice(products)
    const span = tracer.startSpan('user_browse_product', { 'product.id': product })
    span.log(`User browsing product: ${product}`)
    http.get(`${BASE_URL}/api/products/${product}`, { headers: otelHeaders() })
    span.end()
}

function getRecommendations() {
    const product = randomChoice(products)
    const span = tracer.startSpan('user_get_recommendations', { 'product.id': product })
    span.log(`User getting recommendations for product: ${product}`)
    http.get(
        `${BASE_URL}/api/recommendations?productIds=${product}`,
        { headers: otelHeaders() }
    )
    span.end()
}

function getAds() {
    const category = randomChoice(categories)
    const span = tracer.startSpan('user_get_ads', { category: String(category) })
    span.log(`User getting ads for category: ${category}`)
    // When category is null, Locust sends contextKeys=None (Python str(None)).
    const url = category !== null
        ? `${BASE_URL}/api/data/?contextKeys=${category}`
        : `${BASE_URL}/api/data/?contextKeys=None`
    http.get(url, { headers: otelHeaders() })
    span.end()
}

function viewCart() {
    const span = tracer.startSpan('user_view_cart')
    span.log('User viewing cart')
    http.get(`${BASE_URL}/api/cart`, { headers: otelHeaders() })
    span.end()
}

function addToCart(user) {
    if (!user) user = uuid4()
    const product = randomChoice(products)
    const quantity = randomChoice([1, 2, 3, 4, 5, 10])
    const span = tracer.startSpan(
        'user_add_to_cart',
        { 'user.id': user, 'product.id': product, quantity }
    )
    span.log(`User ${user} adding ${quantity} of product ${product} to cart`)
    const h = otelHeaders()
    http.get(`${BASE_URL}/api/products/${product}`, { headers: h })
    http.post(
        `${BASE_URL}/api/cart`,
        JSON.stringify({ item: { productId: product, quantity }, userId: user }),
        { headers: otelHeaders({ 'Content-Type': 'application/json' }) }
    )
    span.end()
}

function checkout() {
    const user = uuid4()
    const span = tracer.startSpan('user_checkout_single', { 'user.id': user })
    span.log(`Starting checkout for user ${user}`)

    addToCart(user)

    http.post(
        `${BASE_URL}/api/checkout`,
        JSON.stringify(Object.assign({}, randomChoice(people), { userId: user })),
        { headers: otelHeaders({ 'Content-Type': 'application/json' }) }
    )
    span.log(`Checkout completed for user ${user}`)
    span.end()
}

function checkoutMulti() {
    const user = uuid4()
    const itemCount = randomChoice([2, 3, 4])
    const span = tracer.startSpan('user_checkout_multi', { 'user.id': user, 'item.count': itemCount })
    span.log(`Starting multi-item checkout for user ${user}, ${itemCount} items`)

    for (let i = 0; i < itemCount; i++) {
        addToCart(user)
    }

    http.post(
        `${BASE_URL}/api/checkout`,
        JSON.stringify(Object.assign({}, randomChoice(people), { userId: user })),
        { headers: otelHeaders({ 'Content-Type': 'application/json' }) }
    )
    span.log(`Multi-item checkout completed for user ${user}`)
    span.end()
}

function floodHome() {
    const floodCount = getFlagdValue('loadGeneratorFloodHomepage')
    if (floodCount <= 0) return

    const span = tracer.startSpan('user_flood_home', { 'flood.count': floodCount })
    span.log(`User flooding homepage ${floodCount} times`)
    const h = otelHeaders()
    for (let i = 0; i < floodCount; i++) {
        http.get(`${BASE_URL}/`, { headers: h })
    }
    span.end()
}

// Generates a fresh email per call so orders don't accumulate against a small
// fixed pool of customers. Without this, store-chat's lookup_orders returns an
// ever-growing list per email, and Strands' auto cache writes a larger prefix
// to Bedrock every turn.
function randomEmail() {
    return `loadgen-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}@aurelia.honeydemo.io`
}

// Inline order flow so the store-chat session has something to look up.
function placeOrderForChat(user, email) {
    const itemCount = randomChoice([1, 2, 3])
    for (let i = 0; i < itemCount; i++) {
        const product = randomChoice(products)
        const quantity = randomChoice([1, 2, 3])
        http.get(`${BASE_URL}/api/products/${product}`, { headers: otelHeaders() })
        http.post(
            `${BASE_URL}/api/cart`,
            JSON.stringify({ item: { productId: product, quantity }, userId: user }),
            { headers: otelHeaders({ 'Content-Type': 'application/json' }) }
        )
    }
    const checkoutPerson = Object.assign({}, randomChoice(people), { userId: user, email })
    http.post(
        `${BASE_URL}/api/checkout`,
        JSON.stringify(checkoutPerson),
        { headers: otelHeaders({ 'Content-Type': 'application/json' }) }
    )
}

function storeChatTurn(question, sessionIdForChat, email, turnIndex) {
    const span = tracer.startSpan('user_store_chat_turn', {
        'session.id': sessionIdForChat,
        'turn.index': turnIndex,
        question,
    })
    http.post(
        `${BASE_URL}/store-chat/chat`,
        JSON.stringify({ question, sessionId: sessionIdForChat, email }),
        { headers: otelHeaders({ 'Content-Type': 'application/json' }) }
    )
    span.end()
}

// store-chat is the post-purchase customer-service agent (orders, refunds,
// shipping status). Rate-limited per VU to ~1/10min so AI spend stays
// bounded; picks a randomized turn count so some sessions are quick and some
// are longer.
function askStoreChat() {
    if (!agentLoadEnabled) return
    const now = Date.now() / 1000
    if (now - lastStoreChatRun < AI_TASK_MIN_INTERVAL_SECONDS) return
    lastStoreChatRun = now

    const email = randomEmail()
    const user = uuid4()
    const chatSessionId = uuid4()

    const placeOrderSpan = tracer.startSpan('user_store_chat_place_order', { 'user.id': user, email })
    placeOrderSpan.log(`Placing order for store-chat session as ${email}`)
    placeOrderForChat(user, email)
    placeOrderSpan.end()

    const fullConversation = randomChoice(STORE_CHAT_CONVERSATIONS)
    const nTurns = 1 + Math.floor(cryptoRandom() * fullConversation.length)
    const conversation = fullConversation.slice(0, nTurns)

    const chatSpan = tracer.startSpan('user_ask_store_chat', {
        'session.id': chatSessionId,
        email,
        'conversation.length': conversation.length,
    })
    chatSpan.log(`Starting store-chat session ${chatSessionId} as ${email} (${conversation.length} turns)`)
    conversation.forEach((question, turnIndex) => {
        storeChatTurn(question, chatSessionId, email, turnIndex)
    })
    chatSpan.end()
}

// Very rare: simulate a frustrated customer who pastes their entire forwarded
// email thread with support into a single chat turn. /chat doesn't bound the
// user `question` size before sending it to the model, so this one
// conversation balloons LLM input_tokens vs. a normal session -- a clean
// per-conversation token spike to investigate.
function askStoreChatPastedEmail() {
    if (!agentLoadEnabled) return
    const now = Date.now() / 1000
    if (now - lastPastedEmailRun < PASTED_EMAIL_TASK_MIN_INTERVAL_SECONDS) return
    lastPastedEmailRun = now

    const email = randomEmail()
    const user = uuid4()
    const chatSessionId = uuid4()

    const placeOrderSpan = tracer.startSpan('user_store_chat_place_order', { 'user.id': user, email })
    placeOrderSpan.log(`Placing order for pasted-email store-chat session as ${email}`)
    placeOrderForChat(user, email)
    placeOrderSpan.end()

    const question =
        "Hi — my telescope order is severely delayed and your support has " +
        'been bouncing me between agents for two weeks. I\'m pasting the ' +
        "entire email thread below so the next person doesn't have to make " +
        'me re-explain it. Please tell me what is actually going on with ' +
        'my order and whether I should expect it before May 22.\n\n' +
        PASTED_EMAIL_THREAD

    const chatSpan = tracer.startSpan('user_ask_store_chat', {
        'session.id': chatSessionId,
        email,
        'conversation.length': 1,
        scenario: 'pasted_email_thread',
    })
    chatSpan.log(`Starting pasted-email store-chat session ${chatSessionId} as ${email}`)
    storeChatTurn(question, chatSessionId, email, 0)
    chatSpan.end()
}

// Flag-gated: when storechatRefundBackupOrders is on, route refund traffic
// against a tiny fixed pool of emails so orders pile up against each one.
// lookup_orders has no pagination, so the JSON returned to the refund agent
// grows over time and the per-conversation LLM input_tokens climb with it.
function askStoreChatRefundBackup() {
    if (!agentLoadEnabled) return
    if (getFlagdValue('storechatRefundBackupOrders') <= 0) return
    const now = Date.now() / 1000
    if (now - lastRefundBackupRun < AI_TASK_MIN_INTERVAL_SECONDS) return
    lastRefundBackupRun = now

    const email = randomChoice(BACKUP_REFUND_EMAILS)
    const user = uuid4()
    const chatSessionId = uuid4()

    const placeOrderSpan = tracer.startSpan('user_store_chat_place_order', {
        'user.id': user, email, scenario: 'refund_backup',
    })
    placeOrderSpan.log(`Placing order for refund-backup store-chat session as ${email}`)
    placeOrderForChat(user, email)
    placeOrderSpan.end()

    const conversation = [
        'Can you pull up my recent orders? I think I need to return one.',
        'Yes please refund my most recent order — it arrived damaged.',
        'Actually one of the earlier ones was the wrong model too, can you refund that one as well?',
    ]
    const chatSpan = tracer.startSpan('user_ask_store_chat', {
        'session.id': chatSessionId,
        email,
        'conversation.length': conversation.length,
        scenario: 'refund_backup',
    })
    chatSpan.log(`Starting refund-backup store-chat session ${chatSessionId} as ${email} (${conversation.length} turns)`)
    conversation.forEach((question, turnIndex) => {
        storeChatTurn(question, chatSessionId, email, turnIndex)
    })
    chatSpan.end()
}

// ---- weighted task selection ------------------------------------------------
// Task weights: index(1) browse(10) recs(3) ads(3) cart(3) add(2)
// checkout(1) checkout_multi(1) flood(5) store_chat(1) pasted_email(1)
// refund_backup(1) = 32

const weightedTasks = [
    { cumWeight:  1, task: index },
    { cumWeight: 11, task: browseProduct },
    { cumWeight: 14, task: getRecommendations },
    { cumWeight: 17, task: getAds },
    { cumWeight: 20, task: viewCart },
    { cumWeight: 22, task: addToCart },
    { cumWeight: 23, task: checkout },
    { cumWeight: 24, task: checkoutMulti },
    { cumWeight: 29, task: floodHome },
    { cumWeight: 30, task: askStoreChat },
    { cumWeight: 31, task: askStoreChatPastedEmail },
    { cumWeight: 32, task: askStoreChatRefundBackup },
]

function selectTask() {
    const r = cryptoRandom() * 32
    for (const { cumWeight, task } of weightedTasks) {
        if (r < cumWeight) return task
    }
    return weightedTasks[weightedTasks.length - 1].task
}

// ---- HTTP entrypoint --------------------------------------------------------

export function httpScenario() {
    if (getFlagdValue('loadGeneratorTraffic') <= 0) {
        sleep(cryptoRandom() * 9 + 1)
        return
    }

    if (sessionId === null) {
        onStart()
    }

    selectTask()()

    sleep(cryptoRandom() * 9 + 1)  // mirrors Locust between(1, 10)
}

// ---- browser tasks ----------------------------------------------------------

async function changeCurrency(page) {
    await page.goto(`${BASE_URL}/cart`, { waitUntil: 'domcontentloaded' })
    await page.selectOption('[name="currency_code"]', 'CHF')
    await page.waitForTimeout(2000)
}

async function addProductToCartBrowser(page) {
    // Roof Binoculars (2ZYFJ3GM2N). Selects by href / data-cy rather than
    // :has-text(), which k6 browser's native CSS engine does not support
    // (it forwards selectors straight to document.querySelectorAll, unlike
    // Playwright's own selector engine).
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('a[href="/product/2ZYFJ3GM2N"]', { timeout: 15000 })
    await page.click('a[href="/product/2ZYFJ3GM2N"]')
    await page.waitForLoadState('domcontentloaded')
    await page.click('[data-cy="product-add-to-cart"]')
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2000)
}

// ---- browser entrypoint -----------------------------------------------------

export async function browserScenario() {
    if (getFlagdValue('loadGeneratorTraffic') <= 0) {
        sleep(cryptoRandom() * 9 + 1)
        return
    }

    const page = await browser.newPage()
    const isCurrencyChange = cryptoRandom() < 0.5
    const span = tracer.startSpan(isCurrencyChange ? 'browser_change_currency' : 'browser_add_to_cart')
    try {
        await page.setExtraHTTPHeaders({ baggage: 'synthetic_request=true' })
        if (isCurrencyChange) {
            span.log('Currency changed to CHF')
            await changeCurrency(page)
        } else {
            span.log('Product added to cart successfully')
            await addProductToCartBrowser(page)
        }
    } catch (e) {
        console.error(`browser task error: ${e}`)
    } finally {
        span.end()
        await page.close()
    }

    sleep(cryptoRandom() * 9 + 1)
}
