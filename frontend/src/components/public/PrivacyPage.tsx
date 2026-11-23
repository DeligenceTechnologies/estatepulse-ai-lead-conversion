import React from 'react';
import { PRIVACY } from '../../content/privacy';
import { LegalPage } from './LegalPage';

/** /privacy, open to everyone. */
export const PrivacyPage: React.FC = () => <LegalPage doc={PRIVACY} related={{ to: '/terms', label: 'Terms & Conditions' }} />;
