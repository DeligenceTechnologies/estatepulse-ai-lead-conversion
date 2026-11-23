/**
 * Shared shape and company details for the public legal pages (/terms, /privacy).
 *
 * LEGAL_ENTITY is the one place the company's own details live. The bracketed
 * values are placeholders: they must be replaced with the real details, and the
 * documents reviewed by a lawyer, before these pages are relied on in production.
 */
export const LEGAL_ENTITY = {
  productName: 'EstatePulse AI',
  companyName: '[Company legal name]',
  contactEmail: '[contact email]',
  postalAddress: '[Company postal address]',
  governingLaw: '[governing jurisdiction]',
  lastUpdated: '23 November 2026',
} as const;

/** A paragraph, or a bullet list when it is an array. */
export type LegalBlock = string | readonly string[];

export interface LegalSection {
  /** Anchor id, unique within the document. */
  id: string;
  heading: string;
  body: readonly LegalBlock[];
}

export interface LegalDocument {
  title: string;
  intro: string;
  sections: readonly LegalSection[];
}
