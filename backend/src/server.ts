import { createApp } from './app.js';
import { prisma } from './db.js';
import { env } from './env.js';

const server = createApp().listen(env.PORT, () => {
  console.log(`API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

const shutdown = (signal: string): void => {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    void prisma.$disconnect().then(() => process.exit(0));
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
