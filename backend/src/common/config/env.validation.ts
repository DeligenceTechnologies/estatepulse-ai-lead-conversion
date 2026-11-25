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

    // Nango holds the OAuth grants for Google, Airtable, HubSpot and Calendly
    // (consent, token storage and refresh). Unset = those integrations say
    // "not configured" instead of failing at boot.
    NANGO_SECRET_KEY: Joi.string().empty('').optional(),
    // Environment Settings → Webhooks → Signing key. A different key from the
    // API key; without it Nango's webhooks (refresh failures) are refused.
    NANGO_WEBHOOK_SIGNING_KEY: Joi.string().empty('').optional(),
    // Only for a self-hosted Nango. Default https://api.nango.dev.
    NANGO_HOST: Joi.string().uri({ scheme: ['http', 'https'] }).empty('').optional(),

    // Optional, and only so a disconnect can revoke the Calendly grant at
    // Calendly (Nango deletes its copy, but does not revoke at the provider).
    // The same OAuth app as the "calendly" integration in Nango.
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
    // On an AI call the assistant waits for answering-machine detection to say a person picked up, at most this long. 0 starts it at once.
    AI_OPENING_WAIT_MS: Joi.number().integer().min(0).default(5_000),
    STRATEGY_STALE_MS: Joi.number().integer().positive().default(86_400_000),
    FOLLOWUP_POLL_MS: Joi.number().integer().positive().default(60_000),
    FOLLOWUP_BATCH_SIZE: Joi.number().integer().positive().default(20),
    FOLLOWUP_STUCK_AFTER_MS: Joi.number().integer().positive().default(600_000),
    // "Call now / schedule" for approved imports, paced by the org's call limits.
    // Off: approving releases leads at once, exactly as before.
    OUTREACH_SCHEDULING_ENABLED: Joi.boolean().truthy('true').truthy('1').falsy('false').falsy('0').empty('').default(false),
    OUTREACH_POLL_MS: Joi.number().integer().positive().default(15_000),

    // The owners' daily summary email: leads, calls, texts and meetings. Each
    // organization picks its send time in Settings; one the server missed (it
    // was down) still goes out for DAILY_SUMMARY_CATCH_UP_HOURS after it.
    DAILY_SUMMARY_ENABLED: Joi.boolean().truthy('true').truthy('1').falsy('false').falsy('0').empty('').default(true),
    DAILY_SUMMARY_CATCH_UP_HOURS: Joi.number().integer().min(1).max(12).default(6),
    DAILY_SUMMARY_POLL_MS: Joi.number().integer().min(10_000).default(60_000),

    GOOGLE_SHEETS_ENABLED: Joi.boolean().truthy('true').truthy('1').falsy('false').falsy('0').empty('').default(false),
    // Public: the Google Picker runs in the browser with it. Must be the same
    // OAuth client as the "google" integration in Nango (whose secret lives
    // only in Nango), or a file picked grants this app nothing.
    GOOGLE_CLIENT_ID: Joi.string().empty('').optional(),
    GOOGLE_PICKER_API_KEY: Joi.string().empty('').optional(),
    GOOGLE_APP_ID: Joi.string().empty('').optional(),
    SHEETS_SYNC: Joi.boolean().truthy('true').truthy('1').falsy('false').falsy('0').empty('').default(false),
    SHEETS_POLL_MS: Joi.number().integer().positive().default(60_000),
    SHEETS_SYNC_INTERVAL_MS: Joi.number().integer().positive().default(300_000),
    SHEETS_VERSION_PROBE: Joi.boolean().truthy('true').truthy('1').falsy('false').falsy('0').empty('').default(false),
    SHEETS_FULL_READ_MAX_AGE_MS: Joi.number().integer().positive().default(21_600_000),

    // Google Forms. An Apps Script on the owner's form posts each response to
    // ingest/v1/google-forms/:token (the primary delivery); polling
    // forms.responses.list only recovers what the script failed to deliver.
    // Off unless GOOGLE_FORMS_ENABLED: the ingest route and every management
    // route answer 404 and the card is hidden. Reuses the Google OAuth client
    // and the drive.file scope that Google Sheets already connects with.
    GOOGLE_FORMS_ENABLED: Joi.boolean().truthy('true').truthy('1').falsy('false').falsy('0').empty('').default(false),
    // How often the recovery poller looks for sources that are due.
    FORMS_POLL_MS: Joi.number().integer().positive().default(60_000),
    // How long after a successful poll a source is due again.
    FORMS_SYNC_INTERVAL_MS: Joi.number().integer().positive().default(900_000),

    FILE_IMPORT_ENABLED: Joi.boolean().truthy('true').truthy('1').falsy('false').falsy('0').empty('').default(false),
    FILE_IMPORT_MAX_BYTES: Joi.number().integer().positive().default(5 * 1024 * 1024),

    // Custom webhooks: a URL any app can post a lead to; the owner maps the first
    // payload's fields on screen. Off unless CUSTOM_WEBHOOK_ENABLED: the ingest
    // route (ingest/v1/custom/:token) and the management routes answer 404 and
    // the card is hidden. Switching it off changes no data.
    CUSTOM_WEBHOOK_ENABLED: Joi.boolean().truthy('true').truthy('1').falsy('false').falsy('0').empty('').default(false),

    // HubSpot CRM import. Off unless HUBSPOT_ENABLED: its endpoints answer 404 and nothing syncs.
    // The OAuth flow and tokens are Nango's ("hubspot" integration). The same
    // app's client id/secret are still needed here: token introspection (which
    // HubSpot account was connected) and HubSpot's v3 webhook signatures use them.
    HUBSPOT_ENABLED: Joi.boolean().truthy('true').truthy('1').falsy('false').falsy('0').empty('').default(false),
    // The webhook target exactly as registered with HubSpot (part of what it signs).
    // Defaults to ${PUBLIC_API_URL}/ingest/v1/crm/hubspot/webhook.
    HUBSPOT_API_BASE_URL: Joi.string().uri().default('https://api.hubapi.com'),
    HUBSPOT_API_VERSION: Joi.string().pattern(/^\d{4}-\d{2}$/).default('2026-09'),
    HUBSPOT_RETRY_BASE_MS: Joi.number().integer().min(0).default(1000),
    // How often the worker looks for due CRM work (0 = only when nudged), and how often each
    // connection is reconciled against the CRM's modified dates to catch a lost webhook.
    CRM_POLL_MS: Joi.number().integer().min(0).default(30_000),
    CRM_RECONCILE_INTERVAL_MS: Joi.number().integer().positive().default(3_600_000),

    // Airtable two-way sync. Off unless AIRTABLE_ENABLED: its endpoints answer 404 and nothing syncs.
    // The OAuth flow and tokens are Nango's ("airtable" integration).
    AIRTABLE_ENABLED: Joi.boolean().truthy('true').truthy('1').falsy('false').falsy('0').empty('').default(false),
    // Space-separated: the scopes the "airtable" integration in Nango requests, so the card can
    // say which were not granted. Must include schema.bases:read and data.records:read. Drop
    // schema.bases:write (here and in Nango) to run without column creation.
    AIRTABLE_SCOPES: Joi.string().empty('').optional(),
    AIRTABLE_API_BASE_URL: Joi.string().uri().default('https://api.airtable.com'),
    AIRTABLE_RETRY_BASE_MS: Joi.number().integer().min(0).default(1000),
    // Airtable allows 5 requests a second per base, so 200ms between requests is
    // exactly that ceiling. 0 switches the pacing off.
    AIRTABLE_MIN_REQUEST_GAP_MS: Joi.number().integer().min(0).default(200),
    // How often the worker looks for due Airtable work (0 = only when nudged), and how often a
    // table is re-read in full to catch anything a webhook missed.
    AIRTABLE_POLL_MS: Joi.number().integer().min(0).default(30_000),
    AIRTABLE_RECONCILE_INTERVAL_MS: Joi.number().integer().positive().default(3_600_000),

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