import { LEGAL_ENTITY, type LegalDocument } from './legal';

const { productName, companyName, contactEmail, postalAddress } = LEGAL_ENTITY;

/**
 * Privacy Policy shown at /privacy.
 *
 * A draft written from what the product stores and sends today. It needs legal
 * review before it is relied on, and must be updated when that behaviour changes
 * (for example if analytics or a new provider is added).
 */
export const PRIVACY: LegalDocument = {
  title: 'Privacy Policy',
  intro: `This policy explains what personal information ${companyName} ("we", "us") handles when you use ${productName} (the "Service"), and what we do with it.`,
  sections: [
    {
      id: 'who-we-are',
      heading: 'Who we are',
      body: [`${productName} is provided by ${companyName}, ${postalAddress}. You can reach us about privacy at ${contactEmail}.`],
    },
    {
      id: 'whose-information',
      heading: 'Whose information this covers',
      body: [
        'The Service handles information about two groups of people:',
        [
          'Account users: the owners and agents who sign in to the Service.',
          'Leads: the people our customers contact through the Service.',
        ],
        'For leads, the customer decides who is contacted and why, and we handle that information on the customer’s behalf and on their instructions. If you were contacted by a business using the Service and have a question or request about your information, please contact that business first. We will help them respond.',
      ],
    },
    {
      id: 'what-we-collect',
      heading: 'What we collect',
      body: [
        'About account users:',
        [
          'name, email address, phone number, and the name and time zone of your organization;',
          'your password, stored in hashed form;',
          'the IP address and browser details of each sign-in session;',
          'working details an owner sets for agents, such as territories, working hours and lead capacity.',
        ],
        'About leads, as provided by the customer or collected during contact:',
        [
          'contact details such as name, email address and phone number;',
          'details of what they are looking for, such as budget, financing, location and timeline, and the answers they give to qualification questions;',
          'where the lead came from, including any campaign tags sent with the form;',
          'records of calls and text messages, including call recordings where recording is switched on, transcripts, AI-written summaries and details extracted from them;',
          'consent and do-not-contact status.',
        ],
        'We also store the credentials you give us for connected services, such as your telephony provider. These are stored encrypted.',
      ],
    },
    {
      id: 'how-we-use-it',
      heading: 'How we use it',
      body: [
        [
          'to provide the Service: receiving leads, placing calls and sending texts for the customer, qualifying leads and assigning them to agents;',
          'to sign you in and keep accounts secure;',
          'to send service emails, such as email verification, password resets, lead assignments and summaries;',
          'to fix problems, prevent abuse and meet legal obligations.',
        ],
        'We do not sell personal information.',
      ],
    },
    {
      id: 'service-providers',
      heading: 'Service providers',
      body: [
        'We share information with providers only as needed to run the Service:',
        [
          'Telephony and AI: calls, text messages and the AI models behind the assistant run through the customer’s own telephony provider account (currently Telnyx). Call recordings and transcripts are held with that provider.',
          'Email delivery: a provider that sends our service emails.',
          'Hosting and database: providers that host the Service and store its data.',
          'Connected services: any form, spreadsheet, CRM or calendar a customer chooses to connect receives or sends the information needed for that connection.',
        ],
        'We may also disclose information where the law requires it.',
      ],
    },
    {
      id: 'retention',
      heading: 'How long we keep it',
      body: [
        'We keep account and lead information while the organization’s account is open, so the Service can work. An owner can ask us to delete their organization and its data by contacting us.',
        'Recordings and conversation history held with the telephony provider are also subject to that provider’s settings and retention rules.',
      ],
    },
    {
      id: 'cookies',
      heading: 'Cookies and local storage',
      body: [
        'We use a sign-in cookie to keep you signed in, and your browser’s local storage to remember display preferences such as light or dark mode. We do not use advertising or tracking cookies.',
        'The site loads its fonts from Google Fonts, so your browser makes a request to Google when a page loads.',
      ],
    },
    {
      id: 'security',
      heading: 'Security',
      body: [
        'Each organization’s data is kept separate from every other organization’s, passwords are hashed, and credentials for connected services are encrypted. No system is perfectly secure, so we cannot guarantee security, but we work to protect the information we hold.',
      ],
    },
    {
      id: 'your-rights',
      heading: 'Your choices and rights',
      body: [
        'Depending on where you live, you may have the right to ask for a copy of your personal information, to have it corrected or deleted, or to object to how it is used. Contact us to make a request.',
        'If you are a lead, you can stop text messages at any time by replying STOP, and you can tell the caller on any call that you do not want to be contacted again.',
      ],
    },
    {
      id: 'changes',
      heading: 'Changes to this policy',
      body: [
        'We may update this policy as the Service changes. When we do, we will change the "Last updated" date on this page, and for significant changes we will tell account owners.',
      ],
    },
    {
      id: 'contact',
      heading: 'Contact',
      body: [`Questions or requests about privacy can be sent to ${contactEmail}, or by post to ${companyName}, ${postalAddress}.`],
    },
  ],
};
