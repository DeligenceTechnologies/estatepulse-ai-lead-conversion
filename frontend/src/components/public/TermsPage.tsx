import React from 'react';
import { TERMS } from '../../content/terms';
import { LegalPage } from './LegalPage';

/** /terms, open to everyone. */
export const TermsPage: React.FC = () => <LegalPage doc={TERMS} related={{ to: '/privacy', label: 'Privacy Policy' }} />;
