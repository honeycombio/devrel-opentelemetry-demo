FROM docker.io/library/node:22-slim AS builder

WORKDIR /usr/src/app/

COPY ./src/chatbot/package.json package.json
COPY ./src/chatbot/package-lock.json package-lock.json

RUN npm ci

COPY ./src/chatbot/tsconfig.json tsconfig.json
COPY ./src/chatbot/src/ src/

RUN npx tsc

# -----------------------------------------------------------------------------

FROM docker.io/library/node:22-slim AS deps

WORKDIR /usr/src/app/

COPY ./src/chatbot/package.json package.json
COPY ./src/chatbot/package-lock.json package-lock.json

RUN npm ci --omit=dev

# -----------------------------------------------------------------------------

FROM gcr.io/distroless/nodejs22-debian12:nonroot

WORKDIR /usr/src/app/

COPY --from=builder /usr/src/app/dist/ dist/
COPY --from=deps /usr/src/app/node_modules/ node_modules/
COPY ./src/chatbot/opentelemetry.js opentelemetry.js

EXPOSE ${CHATBOT_PORT}

CMD ["--require=./opentelemetry.js", "dist/index.js"]
