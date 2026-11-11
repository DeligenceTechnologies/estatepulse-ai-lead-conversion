import { describe, expect, it } from 'vitest';
import { plainText, saidInFrench, smsKeyword } from './sms-keywords';

describe('smsKeyword', () => {
  it.each([
    'STOP',
    'stop.',
    'Stop!!!',
    'STOP ALL',
    'stopall',
    'Unsubscribe',
    'cancel',
    'END',
    'quit',
  ])('reads "%s" as the opt-out Telnyx itself blocks and confirms', (text) => {
    expect(smsKeyword(text)).toEqual({ kind: 'opt_out', french: false, byTelnyx: true });
  });

  it.each([
    'Opt out',
    'opt-out',
    'OPTOUT',
    'revoke',
    'Stop please',
    'please stop',
    'Pls stop 🙏',
    'stop it now',
    'ok stop',
    'stop texting me',
    'Can you stop messaging me',
    'Please remove me from your list',
    'take me off your list',
    'delete my number',
    'leave me alone',
    "don't text me",
    'Do not contact me again',
    'never text me again',
    'I want to opt out',
    'opt me out',
    'how do I unsubscribe?',
  ])('reads "%s" as an opt-out Telnyx does not catch', (text) => {
    expect(smsKeyword(text)).toEqual({ kind: 'opt_out', french: false, byTelnyx: false });
  });

  it.each(['ARRÊT', 'arret', 'Arrête', 'arrêtez svp', "Arrêtez de m'écrire", 'désabonnez-moi', 'je veux me désinscrire'])(
    'reads the French "%s" as an opt-out, answered in French',
    (text) => {
      expect(smsKeyword(text)).toEqual({ kind: 'opt_out', french: true, byTelnyx: false });
    },
  );

  it.each([
    'Yes',
    'no',
    'Not right now',
    "don't stop",
    'Can I stop by the open house?',
    'stop by tomorrow at 5',
    'Stop, who is this?',
    "Don't text me after 9pm, I work late",
    'Cancel my appointment please',
    'We need to end our lease first',
    'I need help finding a 3 bed in Austin',
    'Please send me more info about the house',
    '',
    '   ',
  ])('leaves "%s" to the conversation', (text) => {
    expect(smsKeyword(text)).toBeNull();
  });

  it('reads START and UNSTOP as an opt-in, and nothing else', () => {
    expect(smsKeyword('START')?.kind).toBe('opt_in');
    expect(smsKeyword('unstop.')?.kind).toBe('opt_in');
    expect(smsKeyword('yes start')).toBeNull();
  });

  it('reads HELP, INFO and AIDE as a request for help, AIDE in French', () => {
    expect(smsKeyword('HELP')).toEqual({ kind: 'help', french: false, byTelnyx: false });
    expect(smsKeyword('info?')).toEqual({ kind: 'help', french: false, byTelnyx: false });
    expect(smsKeyword('Aide')).toEqual({ kind: 'help', french: true, byTelnyx: false });
  });

  it("trusts Telnyx's own keyword verdict over the text", () => {
    expect(smsKeyword('please no more', 'STOP')).toEqual({ kind: 'opt_out', french: false, byTelnyx: true });
    expect(smsKeyword('whatever', 'start')?.kind).toBe('opt_in');
    expect(smsKeyword('hmm', 'HELP')?.kind).toBe('help');
  });
});

describe('plainText', () => {
  it('drops case, accents, apostrophes and punctuation', () => {
    expect(plainText("  ARRÊTEZ de m'écrire!! ")).toBe('arretez de mecrire');
    expect(plainText('Opt-out.')).toBe('opt out');
  });
});

describe('saidInFrench', () => {
  it('spots a French opt-out', () => {
    expect(saidInFrench('Arrêtez svp')).toBe(true);
    expect(saidInFrench('please stop')).toBe(false);
  });
});
