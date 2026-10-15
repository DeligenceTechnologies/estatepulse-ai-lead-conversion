import Joi from 'joi';

const POSTGRES_URL = /^postgres(ql)?:\/\/\S+$/;

export const envValidationSchema = Joi.object({
    DATABASE_URL: Joi.string().pattern(POSTGRES_URL).required(),
    DIRECT_URL: Joi.string().pattern(POSTGRES_URL).required(),
    REDIS_URL: Joi.string().uri({ scheme: ['redis', 'rediss'] }).required(),
    EMAIL_WORKER_ENABLED: Joi.boolean().truthy('true').truthy('1').falsy('false').falsy('0').empty('').default(true),
    EMAIL_WORKER_CONCURRENCY: Joi.number().integer().min(1).max(50).default(5),

    PORT: Joi.number().port().default(4000),

    NODE_ENV: Joi.string()
        .valid('development', 'test', 'production')
        .default('development'),

    LOG_LEVEL: Joi.string().default('info'),

    CORS_ORIGIN: Joi.string().empty('').optional(),

    APP_URL: Joi.string().uri({ scheme: ['http', 'https'] }).empty('').optional(),

    JWT_ACCESS_SECRET: Joi.string().min(32).required(),
    JWT_REFRESH_SECRET: Joi.string().min(32).invalid(Joi.ref('JWT_ACCESS_SECRET')).required(),
    JWT_ACCESS_EXPIRES_IN_SECONDS: Joi.number().integer().positive().default(15 * 60),
    REFRESH_TOKEN_EXPIRES_IN_SECONDS: Joi.number().integer().positive().default(24 * 60 * 60),
    REFRESH_TOKEN_KEEP_SIGNED_IN_EXPIRES_IN_SECONDS: Joi.number().integer().positive().default(30 * 24 * 60 * 60),
    COOKIE_SECURE: Joi.boolean()
        .truthy('true')
        .falsy('false')
        .empty('')
        .default(Joi.ref('NODE_ENV', { adjust: (env) => env === 'production' })),

    MAIL_PROVIDER: Joi.string().valid('smtp', 'resend').empty('').optional(),

    MAIL_FROM: Joi.string().empty('').when('MAIL_PROVIDER', {
        is: Joi.exist(),
        then: Joi.required(),
    }),

    SMTP_HOST: Joi.string().empty('').when('MAIL_PROVIDER', {
        is: 'smtp',
        then: Joi.required(),
    }),
    SMTP_PORT: Joi.number().port().empty('').default(587),
    SMTP_USER: Joi.string().empty('').optional(),
    SMTP_PASS: Joi.string().empty('').optional(),
    SMTP_SECURE: Joi.boolean()
        .truthy('true')
        .falsy('false')
        .empty('')
        .default(false),

    RESEND_API_KEY: Joi.string().empty('').when('MAIL_PROVIDER', {
        is: 'resend',
        then: Joi.required(),
    }),

    INTEGRATION_ENCRYPTION_KEY: Joi.string().base64().empty('').optional(),

    CALENDLY_CLIENT_ID: Joi.string().empty('').optional(),
    CALENDLY_CLIENT_SECRET: Joi.string().empty('').optional(),
    // Must match the redirect URI registered on the Calendly OAuth app and reach
    // GET /org-settings/calendar/calendly/callback on this server.
    CALENDLY_REDIRECT_URI: Joi.string().uri({ scheme: ['http', 'https'] }).empty('').optional(),
    CALENDLY_SCOPES: Joi.string().empty('').optional(),
    // Public https address of this API, e.g. https://api.example.com. When set, Calendly and Cal.com
    // push booking changes to POST /calendar-webhooks/:connectionId; without it availability is polled only.
    CALENDAR_WEBHOOK_BASE_URL: Joi.string().uri({ scheme: ['https'] }).empty('').optional(),

    // Public address of this API that third parties call back: lead form webhooks,
    // Telnyx call events and AI tool calls, e.g. https://api.example.com.
    PUBLIC_API_URL: Joi.string().uri({ scheme: ['http', 'https'] }).empty('').optional(),
    // Lets a form provider be pointed at a non-public URL; only for local testing.
    ALLOW_INSECURE_INGEST_URL: Joi.boolean().truthy('true').truthy('1').falsy('false').falsy('0').empty('').default(false),
    INGEST_MAX_BODY_BYTES: Joi.number().integer().positive().default(1_048_576),

    TALLY_API_BASE_URL: Joi.string().uri().default('https://api.tally.so'),
    PROVIDER_HTTP_TIMEOUT_MS: Joi.number().integer().positive().default(10_000),

    // The worker that turns stored form deliveries into leads.
    WORKER_ENABLED: Joi.boolean().truthy('true').truthy('1').falsy('false').falsy('0').empty('').default(true),
    WORKER_POLL_INTERVAL_MS: Joi.number().integer().positive().default(1_000),
    WORKER_MAX_POLL_INTERVAL_MS: Joi.number().integer().positive().default(10_000),
    WORKER_BATCH_SIZE: Joi.number().integer().positive().default(10),
    WORKER_STUCK_AFTER_MS: Joi.number().integer().positive().default(300_000),

    // Calls and texts real people: off unless explicitly switched on.
    STRATEGY_ENGINE: Joi.boolean().truthy('true').truthy('1').falsy('false').falsy('0').empty('').default(false),
    ENGINE_POLL_MS: Joi.number().integer().positive().default(15_000),
    STRATEGY_STALE_MS: Joi.number().integer().positive().default(86_400_000),
    FOLLOWUP_POLL_MS: Joi.number().integer().positive().default(60_000),
    FOLLOWUP_BATCH_SIZE: Joi.number().integer().positive().default(20),
    FOLLOWUP_STUCK_AFTER_MS: Joi.number().integer().positive().default(600_000),

    GOOGLE_SHEETS_ENABLED: Joi.boolean().truthy('true').truthy('1').falsy('false').falsy('0').empty('').default(false),
    GOOGLE_CLIENT_ID: Joi.string().empty('').optional(),
    GOOGLE_CLIENT_SECRET: Joi.string().empty('').optional(),
    // Defaults to ${APP_URL}/oauth/google-callback.html; must match the Google Cloud console exactly.
    GOOGLE_REDIRECT_URI: Joi.string().uri({ scheme: ['http', 'https'] }).empty('').optional(),
    GOOGLE_PICKER_API_KEY: Joi.string().empty('').optional(),
    GOOGLE_APP_ID: Joi.string().empty('').optional(),
    SHEETS_SYNC: Joi.boolean().truthy('true').truthy('1').falsy('false').falsy('0').empty('').default(false),
    SHEETS_POLL_MS: Joi.number().integer().positive().default(60_000),
    SHEETS_SYNC_INTERVAL_MS: Joi.number().integer().positive().default(300_000),
    SHEETS_VERSION_PROBE: Joi.boolean().truthy('true').truthy('1').falsy('false').falsy('0').empty('').default(false),
    SHEETS_FULL_READ_MAX_AGE_MS: Joi.number().integer().positive().default(21_600_000),

    FILE_IMPORT_ENABLED: Joi.boolean().truthy('true').truthy('1').falsy('false').falsy('0').empty('').default(false),
    FILE_IMPORT_MAX_BYTES: Joi.number().integer().positive().default(5 * 1024 * 1024),
});