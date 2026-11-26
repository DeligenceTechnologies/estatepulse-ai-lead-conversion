import Joi from 'joi';

const POSTGRES_URL = /^postgres(ql)?:\/\/\S+$/;

export const envValidationSchema = Joi.object({
    DATABASE_URL: Joi.string().pattern(POSTGRES_URL).required(),
    DIRECT_URL: Joi.string().pattern(POSTGRES_URL).required(),
    REDIS_URL: Joi.string().uri({ scheme: ['redis', 'rediss'] }).required(),
    // Each environment sharing one Redis needs its own, or their workers take each other's jobs.
    QUEUE_PREFIX: Joi.string().pattern(/^[A-Za-z0-9_-]+$/).default('estatepulse'),
    EMAIL_WORKER_ENABLED: Joi.boolean().truthy('true').truthy('1').falsy('false').falsy('0').empty('').default(true),
    EMAIL_WORKER_CONCURRENCY: Joi.number().integer().min(1).max(50).default(5),
    CALL_WORKER_ENABLED: Joi.boolean().truthy('true').truthy('1').falsy('false').falsy('0').empty('').default(true),
    CALL_WORKER_CONCURRENCY: Joi.number().integer().min(1).max(200).default(20),
    CALL_SLOT_TTL_MS: Joi.number().integer().min(60_000).default(1_800_000),

    PORT: Joi.number().port().default(4000),

    NODE_ENV: Joi.string()
        .valid('development', 'test', 'production')
        .default('development'),

    LOG_LEVEL: Joi.string().default('info'),

    CORS_ORIGINS: Joi.string().empty('').optional(),

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
    // New sign-ups must click the emailed link before they can sign in. Needs
    // MAIL_PROVIDER and APP_URL: the server refuses to boot with it on without them.
    EMAIL_VERIFICATION_REQUIRED: Joi.boolean()
        .truthy('true')
        .truthy('1')
        .falsy('false')
        .falsy('0')
        .empty('')
        .default(Joi.ref('NODE_ENV', { adjust: (env) => env === 'production' })),

    MAIL_PROVIDER: Joi.string().valid('smtp', 'resend', 'ses').empty('').optional(),

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

    AWS_SES_REGION: Joi.string().pattern(/^[a-z]{2}(-[a-z]+)+-\d$/).empty('').when('MAIL_PROVIDER', {
        is: 'ses',
        then: Joi.required(),
    }),
    // Both or neither. Unset = the AWS default credential chain (IAM role on
    // EC2/ECS/EKS/Lambda, AWS_PROFILE, AWS_ACCESS_KEY_ID...), preferred in production.
    AWS_SES_ACCESS_KEY_ID: Joi.string().empty('').optional(),
    AWS_SES_SECRET_ACCESS_KEY: Joi.string().empty('').optional(),
    // Routes bounce/complaint/delivery events to the configuration set's event destinations.
    AWS_SES_CONFIGURATION_SET: Joi.string().empty('').optional(),

    INTEGRATION_ENCRYPTION_KEY: Joi.string().base64().empty('').optional(),

    // Public https address of this API, e.g. https://api.example.com. When set, Calendly and Cal.com
    // push booking changes to POST /calendar-webhooks/:connectionId; without it availability is polled only.
    CALENDAR_WEBHOOK_BASE_URL: Joi.string().uri({ scheme: ['https'] }).empty('').optional(),

    // Public address of this API that third parties call back: Telnyx call events
    // and AI tool calls, e.g. https://api.example.com.
    PUBLIC_API_URL: Joi.string().uri({ scheme: ['http', 'https'] }).empty('').optional(),
    // Calls and texts real people: off unless explicitly switched on.
    STRATEGY_ENGINE: Joi.boolean().truthy('true').truthy('1').falsy('false').falsy('0').empty('').default(false),
    ENGINE_POLL_MS: Joi.number().integer().positive().default(15_000),
    // On an AI call the assistant waits for answering-machine detection to say a person picked up, at most this long. 0 starts it at once.
    AI_OPENING_WAIT_MS: Joi.number().integer().min(0).default(5_000),
    STRATEGY_STALE_MS: Joi.number().integer().positive().default(86_400_000),
    FOLLOWUP_POLL_MS: Joi.number().integer().positive().default(60_000),
    FOLLOWUP_BATCH_SIZE: Joi.number().integer().positive().default(20),
    FOLLOWUP_STUCK_AFTER_MS: Joi.number().integer().positive().default(600_000),
    // "Call now / schedule" for approved leads, paced by the org's call limits.
    OUTREACH_SCHEDULING_ENABLED: Joi.boolean().truthy('true').truthy('1').falsy('false').falsy('0').empty('').default(false),
    OUTREACH_POLL_MS: Joi.number().integer().positive().default(15_000),

    // The owners' daily summary email: leads, calls, texts and meetings. Each
    // organization picks its send time in Settings; one the server missed (it
    // was down) still goes out for DAILY_SUMMARY_CATCH_UP_HOURS after it.
    DAILY_SUMMARY_ENABLED: Joi.boolean().truthy('true').truthy('1').falsy('false').falsy('0').empty('').default(true),
    DAILY_SUMMARY_CATCH_UP_HOURS: Joi.number().integer().min(1).max(12).default(6),
    DAILY_SUMMARY_POLL_MS: Joi.number().integer().min(10_000).default(60_000),

    // Billing (Stripe). Without STRIPE_SECRET_KEY the app runs on the free plan for
    // everyone and checkout answers "not configured"; it never fakes a payment.
    // The key must belong to STRIPE_MODE: a live key in test mode (or the reverse)
    // refuses to boot rather than charge the wrong account.
    STRIPE_MODE: Joi.string().valid('test', 'live').default('test'),
    STRIPE_SECRET_KEY: Joi.string().empty('').when('STRIPE_MODE', {
        is: 'live',
        then: Joi.string().pattern(/^(sk|rk)_live_\w+$/).messages({ 'string.pattern.base': 'STRIPE_SECRET_KEY must be a live key (sk_live_/rk_live_) when STRIPE_MODE=live' }),
        otherwise: Joi.string().pattern(/^(sk|rk)_test_\w+$/).messages({ 'string.pattern.base': 'STRIPE_SECRET_KEY must be a test key (sk_test_/rk_test_) when STRIPE_MODE=test' }),
    }).optional(),
    STRIPE_PUBLISHABLE_KEY: Joi.string().pattern(/^pk_(test|live)_\w+$/).empty('').optional(),
    STRIPE_WEBHOOK_SECRET: Joi.string().pattern(/^whsec_\w+$/).empty('').optional(),
    STRIPE_PORTAL_CONFIGURATION_ID: Joi.string().pattern(/^bpc_\w+$/).empty('').optional(),
    STRIPE_AUTOMATIC_TAX: Joi.boolean().truthy('true').truthy('1').falsy('false').falsy('0').empty('').default(false),
    STRIPE_ALLOW_PROMOTION_CODES: Joi.boolean().truthy('true').truthy('1').falsy('false').falsy('0').empty('').default(false),
    STRIPE_STARTER_MONTHLY_PRICE_ID: Joi.string().pattern(/^price_\w+$/).empty('').optional(),
    STRIPE_STARTER_YEARLY_PRICE_ID: Joi.string().pattern(/^price_\w+$/).empty('').optional(),
    STRIPE_PROFESSIONAL_MONTHLY_PRICE_ID: Joi.string().pattern(/^price_\w+$/).empty('').optional(),
    STRIPE_PROFESSIONAL_YEARLY_PRICE_ID: Joi.string().pattern(/^price_\w+$/).empty('').optional(),
    STRIPE_BUSINESS_MONTHLY_PRICE_ID: Joi.string().pattern(/^price_\w+$/).empty('').optional(),
    STRIPE_BUSINESS_YEARLY_PRICE_ID: Joi.string().pattern(/^price_\w+$/).empty('').optional(),
    // Must equal the currency of every configured Stripe Price; checkout checks it.
    BILLING_CURRENCY: Joi.string().pattern(/^[a-zA-Z]{3}$/).default('inr'),
    // Default ${APP_URL}/billing/success, /billing/cancel and /settings?tab=billing.
    BILLING_SUCCESS_URL: Joi.string().uri({ scheme: ['http', 'https'] }).empty('').optional(),
    BILLING_CANCEL_URL: Joi.string().uri({ scheme: ['http', 'https'] }).empty('').optional(),
    BILLING_PORTAL_RETURN_URL: Joi.string().uri({ scheme: ['http', 'https'] }).empty('').optional(),
    // Free trial on an organization's FIRST paid subscription. 0 = none.
    BILLING_TRIAL_DAYS: Joi.number().integer().min(0).max(730).default(0),
    // How long a past_due subscription keeps its paid features while Stripe retries the card.
    BILLING_PAST_DUE_GRACE_DAYS: Joi.number().integer().min(0).max(60).default(7),
    // Off: plan features and limits are computed and logged ("would block") but not
    // enforced, so turning billing on does not lock existing organizations out.
    BILLING_ENFORCEMENT_ENABLED: Joi.boolean().truthy('true').truthy('1').falsy('false').falsy('0').empty('').default(false),
    BILLING_ALLOW_IMMEDIATE_CANCEL: Joi.boolean().truthy('true').truthy('1').falsy('false').falsy('0').empty('').default(false),
    // Retries failed webhook events and re-reads stale subscriptions from Stripe.
    BILLING_RECONCILE_ENABLED: Joi.boolean().truthy('true').truthy('1').falsy('false').falsy('0').empty('').default(true),
}).and('AWS_SES_ACCESS_KEY_ID', 'AWS_SES_SECRET_ACCESS_KEY');