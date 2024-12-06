import bunyan from 'bunyan';

export const logger = bunyan.createLogger({ name: 'myapp', level: 'info' });

// export const logger = pino({
//     level: process.env.PINO_LOG_LEVEL || 'debug',
//     timestamp: pino.stdTimeFunctions.isoTime,
//   });
