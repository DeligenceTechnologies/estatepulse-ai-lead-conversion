import { describe, expect, test, vi } from 'vitest';
import { LeadSourcesService } from './lead-sources.service';

/**
 * The guard behind the Leads screen's source filter: two live sources cannot share a name,
 * because the name is all the dropdown shows and eight alike entries cannot be chosen between.
 */
const setup = (existing: { id: string } | null) => {
  const findFirst = vi.fn().mockResolvedValue(existing);
  const service = new LeadSourcesService(
    { leadSource: { findFirst } } as never,
    {} as never,
    {} as never,
    { get: () => '' } as never,
  );
  return { service, findFirst };
};

describe('assertNameFree', () => {
  test('passes when no live source carries the name', async () => {
    const { service } = setup(null);
    await expect(service.assertNameFree('org-1', 'Website enquiry form')).resolves.toBeUndefined();
  });

  test('refuses a name already taken, and says what to do', async () => {
    const { service } = setup({ id: 'src-1' });
    await expect(service.assertNameFree('org-1', 'Website enquiry form')).rejects.toThrow(
      /already have a lead source called "Website enquiry form"/,
    );
  });

  test('matches whatever the casing and the stray spaces, since a dropdown shows neither', async () => {
    const { service, findFirst } = setup(null);
    await service.assertNameFree('org-1', '  Website Enquiry Form  ');
    expect(findFirst.mock.calls[0][0].where).toMatchObject({
      orgId: 'org-1',
      archivedAt: null,
      name: { equals: 'Website Enquiry Form', mode: 'insensitive' },
    });
  });

  test('a source renaming itself does not collide with itself', async () => {
    const { service, findFirst } = setup(null);
    await service.assertNameFree('org-1', 'Website enquiry form', 'src-1');
    expect(findFirst.mock.calls[0][0].where).toMatchObject({ id: { not: 'src-1' } });
  });
});
