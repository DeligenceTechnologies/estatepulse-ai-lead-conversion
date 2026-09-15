import { PrismaClient } from '@prisma/client';

/**
 * Single long-lived process against the direct (session-mode) connection, so
 * one client instance for the lifetime of the server is correct here.
 */
export const prisma = new PrismaClient();
