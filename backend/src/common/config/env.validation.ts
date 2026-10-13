import Joi from 'joi';

const POSTGRES_URL = /^postgres(ql)?:\/\/\S+$/;

export const envValidationSchema = Joi.object({
    DATABASE_URL: Joi.string().pattern(POSTGRES_URL).required(),
    DIRECT_URL: Joi.string().pattern(POSTGRES_URL).required(),

    PORT: Joi.number().port().default(4000),

    NODE_ENV: Joi.string()
        .valid('development', 'test', 'production')
        .default('development'),

    LOG_LEVEL: Joi.string().default('info'),

    // Comma-separated list of allowed browser origins. Needed for the refresh
    // cookie to be sent cross-origin; leave blank to allow any origin without cookies.
    CORS_ORIGIN: Joi.string().empty('').optional(),

    // The frontend's address, for links in emails (e.g. https://app.example.com).
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

    // 32 random bytes, base64 (openssl rand -base64 32). Encrypts stored integration credentials.
    INTEGRATION_ENCRYPTION_KEY: Joi.string().base64().empty('').optional(),

    CALENDLY_CLIENT_ID: Joi.string().empty('').optional(),
    CALENDLY_CLIENT_SECRET: Joi.string().empty('').optional(),
    // Must match the redirect URI registered on the Calendly OAuth app and reach
    // GET /org-settings/calendar/calendly/callback on this server.
    CALENDLY_REDIRECT_URI: Joi.string().uri({ scheme: ['http', 'https'] }).empty('').optional(),
    // Public https address of this API, e.g. https://api.example.com. When set, Calendly and Cal.com
    // push booking changes to POST /calendar-webhooks/:connectionId; without it availability is polled only.
    CALENDAR_WEBHOOK_BASE_URL: Joi.string().uri({ scheme: ['https'] }).empty('').optional(),
});