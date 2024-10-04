
const bunyan = require('bunyan');

export const logger = bunyan.createLogger({ name: 'api-gateway-logs' });