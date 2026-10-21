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
    TYPEFORM_API_BASE_URL: Joi.string().uri().default('https://api.typeform.com'),
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
    // "Call now / schedule" for approved imports, paced by the org's call limits.
    // Off: approving releases leads at once, exactly as before.
    OUTREACH_SCHEDULING_ENABLED: Joi.boolean().truthy('true').truthy('1').falsy('false').falsy('0').empty('').default(false),
    OUTREACH_POLL_MS: Joi.number().integer().positive().default(15_000),

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

    // Custom webhooks: a URL any app can post a lead to; the owner maps the first
    // payload's fields on screen. Off unless CUSTOM_WEBHOOK_ENABLED: the ingest
    // route (ingest/v1/custom/:token) and the management routes answer 404 and
    // the card is hidden. Switching it off changes no data.
    CUSTOM_WEBHOOK_ENABLED: Joi.boolean().truthy('true').truthy('1').falsy('false').falsy('0').empty('').default(false),

    // HubSpot CRM import. Off unless HUBSPOT_ENABLED: its endpoints answer 404 and nothing syncs.
    // Unset client id/secret = the card says "not configured" instead of failing at boot.
    HUBSPOT_ENABLED: Joi.boolean().truthy('true').truthy('1').falsy('false').falsy('0').empty('').default(false),
    HUBSPOT_CLIENT_ID: Joi.string().empty('').optional(),
    // Also keys HubSpot's v3 webhook signatures, so it must be the same app's secret.
    HUBSPOT_CLIENT_SECRET: Joi.string().empty('').optional(),
    // Defaults to ${APP_URL}/oauth/hubspot-callback.html; must be listed in the app's redirect URLs exactly.
    HUBSPOT_REDIRECT_URI: Joi.string().uri({ scheme: ['http', 'https'] }).empty('').optional(),
    // Space-separated; must include every REQUIRED scope of the HubSpot app. Default: "oauth crm.objects.contacts.read".
    HUBSPOT_SCOPES: Joi.string().empty('').optional(),
    // The webhook target exactly as registered with HubSpot (part of what it signs).
    // Defaults to ${PUBLIC_API_URL}/ingest/v1/crm/hubspot/webhook.
    HUBSPOT_WEBHOOK_URL: Joi.string().uri({ scheme: ['http', 'https'] }).empty('').optional(),
    HUBSPOT_API_BASE_URL: Joi.string().uri().default('https://api.hubapi.com'),
    HUBSPOT_AUTH_BASE_URL: Joi.string().uri().default('https://app.hubspot.com'),
    HUBSPOT_API_VERSION: Joi.string().pattern(/^\d{4}-\d{2}$/).default('2026-09'),
    HUBSPOT_RETRY_BASE_MS: Joi.number().integer().min(0).default(1000),
    // How often the worker looks for due CRM work (0 = only when nudged), and how often each
    // connection is reconciled against the CRM's modified dates to catch a lost webhook.
    CRM_POLL_MS: Joi.number().integer().min(0).default(30_000),
    CRM_RECONCILE_INTERVAL_MS: Joi.number().integer().positive().default(3_600_000),
});