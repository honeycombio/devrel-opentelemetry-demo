
import bunyan from 'bunyan';

export const logger = bunyan.createLogger({ name: 'api-gateway-logs' });