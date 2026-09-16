/**
 * Issues a dashboard API key for an existing organization.
 *
 * This database already carried a populated Phase One schema (organizations,
 * users, organization_members) before this service existed, so the seed
 * deliberately does NOT create an organization — it attaches to one you already
 * have. Creating a duplicate org would fragment the tenant.
 *
 * Usage:
 *   npm run seed                        # uses the first org by created_at
 *   npm run seed -- <org-slug>          # targets a specific org
 */
import { PrismaClient } from '@prisma/client';
import { newId } from '../src/common/ids';
import { generateApiKey } from '../src/common/tokens';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const slugArg = process.argv[2];

  const org = slugArg
    ? await prisma.organizations.findUnique({ where: { slug: slugArg } })
    : await prisma.organizations.findFirst({ orderBy: { created_at: 'asc' } });

  if (!org) {
    const all = await prisma.organizations.findMany({ select: { slug: true, name: true } });
    console.error(
      slugArg
        ? `No organization with slug "${slugArg}".`
        : 'No organizations found — cannot issue an API key.',
    );
    if (all.length) {
      console.error('\nAvailable organizations:');
      for (const o of all) console.error(`  ${o.slug}  (${o.name})`);
    }
    process.exitCode = 1;
    return;
  }

  const existing = await prisma.api_keys.count({
    where: { organization_id: org.id, revoked_at: null },
  });

  // Hashed, not encrypted: we only ever verify a presented key, never reproduce
  // it. Unsalted SHA-256 is right because the key is 192 bits of CSPRNG entropy
  // — there is no dictionary to attack.
  const key = generateApiKey('live');
  await prisma.api_keys.create({
    data: {
      id: newId(),
      organization_id: org.id,
      name: `Dashboard key ${new Date().toISOString().slice(0, 10)}`,
      key_hash: key.hash,
      key_prefix: key.prefix,
      scopes: ['lead_sources:*', 'leads:read', 'deliveries:*'],
    },
  });

  console.log(`\nIssued an API key for: ${org.name} [${org.slug}]`);
  console.log(`  organization id : ${org.id}`);
  if (existing > 0) {
    console.log(`  note            : ${existing} active key(s) already existed; this is additional.`);
  }
  console.log(`\n  API key (shown once — store it now):\n\n    ${key.token}\n`);
  console.log('  Put it in the ROOT .env as API_KEY — NOT VITE_API_KEY, since the');
  console.log('  VITE_ prefix would inline it into the public browser bundle.\n');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
