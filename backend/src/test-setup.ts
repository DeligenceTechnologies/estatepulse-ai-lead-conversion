// Preloaded via --import so NODE_ENV is set before env.ts is evaluated.
// Setting it inside the test file would be too late: ESM hoists imports.
process.env['NODE_ENV'] = 'test';
export {};
