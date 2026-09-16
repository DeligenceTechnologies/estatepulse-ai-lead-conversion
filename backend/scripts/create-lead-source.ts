/**
 * Creates a webhook lead source and prints its ingest URL + signing secret.
 *
 * Interim tooling: this is what the Lead Sources UI will do via
 * POST /v1/lead-sources. It exists now so the ingestion path can be exercised
 * end-to-end against a real Tally form before the management API lands.
 *
 * Usage:
 *   npx tsx scripts/create-lead-source.ts "Buyer Intake Form" [org-slug]
 */
import { PrismaClient } from '@prisma/client';
import { SecretBox, ingestTokenAad, signingSecretAad } from '../src/common/crypto';
import { IngestStatus, MappingStatus } from '../src/common/domain';
import { newId } from '../src/common/ids';
import { generateIngestToken, generateSigningSecret } from '../src/common/tokens';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const name = process.argv[2] ?? 'Tally Lead Form';
  const slug = process.argv[3];

  const box = new SecretBox(
    process.env.ENCRYPTION_KEYS!,
    process.env.ENCRYPTION_ACTIVE_KEY_ID!,
  );

  const org = slug
    ? await prisma.organizations.findUnique({ where: { slug } })
    : await prisma.organizations.findFirst({ orderBy: { created_at: 'asc' } });

  if (!org) {
    console.error(slug ? `No organization with slug "${slug}".` : 'No organizations found.');
    process.exitCode = 1;
    return;
  }

  // The id must exist before we encrypt, because the AAD binds each ciphertext
  // to (organization_id, lead_source_id).
  const id = newId();
  const token = generateIngestToken('live');
  const secret = generateSigningSecret();

  const code = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);

  await prisma.lead_sources.create({
    data: {
      id,
      organization_id: org.id,
      name: name.slice(0, 100),
      code,
      source_type: 'webhook',
      is_active: true,
      ingest_token_hash: token.hash,
      ingest_token_prefix: token.prefix,
      ingest_token_enc: box.encrypt(token.token, ingestTokenAad(org.id, id)),
      signing_secret_enc: box.encrypt(secret, signingSecretAad(org.id, id)),
      signing_secret_last4: secret.slice(-4),
      signing_secret_set_at: new Date(),
      // Default to verifying-if-present rather than requiring. Requiring a
      // signature before the customer has pasted the secret into Tally would
      // quarantine their very first submission, which is a terrible first
      // impression of the product.
      require_signature: false,
      ingest_status: IngestStatus.AWAITING_FIRST_EVENT,
      mapping_status: MappingStatus.UNCONFIGURED,
      auto_create_leads: true,
      default_consent_status: 'pending',
    },
  });

  const base = process.env.PUBLIC_API_BASE_URL ?? 'http://localhost:3001';

  console.log(`\nCreated lead source "${name}" for ${org.name}`);
  console.log(`  id: ${id}\n`);
  console.log('Paste into Tally → Integrations → Webhooks:\n');
  console.log(`  Webhook URL    ${base}/ingest/v1/tally/${token.token}`);
  console.log(`  Signing secret ${secret}\n`);
  console.log('Both are shown once here. The URL can be recovered from the DB');
  console.log('(it is encrypted, not hashed); the secret cannot be read back and');
  console.log('must be rotated if lost.\n');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
