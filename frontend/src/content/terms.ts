import { LEGAL_ENTITY, type LegalDocument } from './legal';

const { productName, companyName, contactEmail, postalAddress, governingLaw } = LEGAL_ENTITY;

/**
 * Terms & Conditions shown at /terms.
 *
 * A draft written from what the product does today. It states no prices and
 * makes no claim that using the product makes a customer compliant with any
 * law. It needs legal review before it is relied on.
 */
export const TERMS: LegalDocument = {
  title: 'Terms & Conditions',
  intro: `These terms are an agreement between you and ${companyName} ("we", "us") for the use of ${productName} (the "Service"). Please read them before you create an account.`,
  sections: [
    {
      id: 'acceptance',
      heading: 'Accepting these terms',
      body: [
        'By creating an account or using the Service you agree to these terms. If you use the Service for a business, you agree on behalf of that business and confirm you have the authority to do so.',
        'If you do not agree, do not use the Service.',
      ],
    },
    {
      id: 'service',
      heading: 'The Service',
      body: [
        `${productName} receives leads from the sources you connect, contacts them with AI voice calls and text messages on your behalf, records what they say they are looking for, and assigns qualified leads to your agents.`,
        'The Service acts on your instructions and settings. You decide which leads are contacted, what the assistant says, and who the leads are assigned to.',
      ],
    },
    {
      id: 'accounts',
      heading: 'Accounts and your team',
      body: [
        'You must give accurate details when you sign up and keep your sign-in details secure. You are responsible for what happens under your account.',
        'The person who creates an organization is its owner. The owner can add agents, and is responsible for their use of the Service and for removing access when someone leaves.',
      ],
    },
    {
      id: 'third-party-services',
      heading: 'Third-party services',
      body: [
        'Calls and text messages are placed through a telephony provider account that you connect (currently Telnyx). That account is yours: its phone numbers, registrations and usage charges are between you and the provider, under the provider’s own terms.',
        'You may also connect forms, spreadsheets, CRMs and calendars. We are not responsible for those services, and your use of them is under their terms.',
        'If a connected service changes, fails or withdraws access, parts of the Service may stop working until the connection is restored.',
      ],
    },
    {
      id: 'outreach-responsibilities',
      heading: 'Your responsibilities when contacting leads',
      body: [
        'You are the sender of every call and message the Service makes for you. You are responsible for following the laws that apply to them, including telemarketing, automated-calling, anti-spam, call-recording and do-not-call rules where you and your leads are located.',
        'In particular, you agree that:',
        [
          'you have the consent the law requires before a lead is called or texted, including consent to be contacted by an automated or AI system where that is required;',
          'the business name, contact details and mailing address you enter are accurate, because they are used to identify you to the people you contact;',
          'you will not remove or work around the disclosure that the caller is an AI assistant, the recording notice where one is required, or the handling of opt-out requests;',
          'you will not use the Service to contact anyone who has asked you not to.',
        ],
        'The Service includes features intended to help with these duties, such as calling-hour limits and opt-out handling. They are aids only. They are not legal advice, and they do not guarantee that your outreach complies with any law.',
      ],
    },
    {
      id: 'acceptable-use',
      heading: 'Acceptable use',
      body: [
        'You agree not to:',
        [
          'use the Service for anything unlawful, deceptive or harassing;',
          'upload or contact lists of people you have no right to contact;',
          'try to access another organization’s data, or probe or disrupt the Service;',
          'copy, resell or reverse engineer the Service, except where the law allows it.',
        ],
      ],
    },
    {
      id: 'ai-output',
      heading: 'AI-generated output',
      body: [
        'Calls, replies, summaries, scores and extracted details are produced by AI models. They can be incomplete or wrong. Check anything important before you act on it.',
        'The assistant does not give legal, financial or mortgage advice, and nothing it says is a commitment by us.',
      ],
    },
    {
      id: 'your-data',
      heading: 'Your data',
      body: [
        'You keep all rights in the lead data, call content and other material you put into the Service ("your data"). You give us permission to store and process it only as needed to provide and support the Service.',
        'You confirm that you are entitled to share your data with us, including personal information about your leads. How we handle personal information is described in our Privacy Policy.',
      ],
    },
    {
      id: 'fees',
      heading: 'Fees',
      body: [
        'Any fees for the Service are those agreed between you and us. If we introduce or change fees, we will tell you in advance, and they will apply only from the date we give you.',
        'Charges from third-party providers, such as your telephony provider, are separate and are paid by you directly to that provider.',
      ],
    },
    {
      id: 'intellectual-property',
      heading: 'Our intellectual property',
      body: [
        'We own the Service, including its software, design and branding. These terms give you a right to use the Service while your account is open, and nothing more.',
        'If you send us feedback, we may use it without any obligation to you.',
      ],
    },
    {
      id: 'availability',
      heading: 'Availability and changes',
      body: [
        'We work to keep the Service available, but we do not promise it will be uninterrupted or error-free. Features may be added, changed or removed, and some may be offered as early or preview features.',
      ],
    },
    {
      id: 'termination',
      heading: 'Suspension and ending the agreement',
      body: [
        'You may stop using the Service at any time, and may ask us to close your account.',
        'We may suspend or close an account that breaks these terms, puts the Service or other people at risk, or is used unlawfully. Where it is reasonable, we will tell you first and give you a chance to fix the problem.',
        'When an account is closed, your right to use the Service ends. Sections that by their nature should continue, such as those on liability, will continue to apply.',
      ],
    },
    {
      id: 'disclaimers',
      heading: 'Disclaimers',
      body: [
        'To the extent the law allows, the Service is provided "as is" and "as available", without warranties of any kind, whether express or implied, including warranties of merchantability, fitness for a particular purpose and non-infringement.',
        'We do not promise that the Service will produce any particular number of leads, appointments or sales.',
      ],
    },
    {
      id: 'liability',
      heading: 'Limitation of liability',
      body: [
        'To the extent the law allows, we are not liable for indirect, incidental, special or consequential losses, or for lost profits, revenue, data or business opportunities.',
        'To the extent the law allows, our total liability for all claims relating to the Service is limited to the fees you paid us for the Service in the twelve months before the claim arose.',
        'Nothing in these terms limits liability that cannot be limited by law.',
      ],
    },
    {
      id: 'indemnity',
      heading: 'Indemnity',
      body: [
        'You agree to cover our losses and costs arising from claims by third parties that result from your data, your outreach to leads, or your breach of these terms or of the law.',
      ],
    },
    {
      id: 'governing-law',
      heading: 'Governing law',
      body: [
        `These terms are governed by the laws of ${governingLaw}, and the courts of ${governingLaw} have jurisdiction over any dispute, unless the law where you live requires otherwise.`,
      ],
    },
    {
      id: 'changes',
      heading: 'Changes to these terms',
      body: [
        'We may update these terms. When we do, we will change the "Last updated" date on this page, and for significant changes we will tell account owners in advance. Continuing to use the Service after a change takes effect means you accept the updated terms.',
      ],
    },
    {
      id: 'contact',
      heading: 'Contact',
      body: [`Questions about these terms can be sent to ${contactEmail}, or by post to ${companyName}, ${postalAddress}.`],
    },
  ],
};
