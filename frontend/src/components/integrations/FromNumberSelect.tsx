import React, { useCallback, useState } from 'react';
import { Phone } from 'lucide-react';
import { OwnedNumber, lookupOwnedNumbers } from '../../utils/assistantApi';
import { RichSelect } from './RichSelect';

/**
 * Verifying a key is the same call as reading its numbers: Telnyx only lists an
 * account's numbers for a key that works. So "verified" here means "we have
 * this key's numbers", and the number picker stays hidden until then.
 */
export function useNumberLookup() {
  const [numbers, setNumbers] = useState<OwnedNumber[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The key the numbers belong to; '' for the stored key. */
  const [verifiedFor, setVerifiedFor] = useState<string | null>(null);

  const verify = useCallback(async (apiKey?: string) => {
    const key = apiKey?.trim() || '';
    setLoading(true);
    setError(null);
    try {
      setNumbers(await lookupOwnedNumbers(key || undefined));
      setVerifiedFor(key);
      return true;
    } catch (e: any) {
      setNumbers(null);
      setVerifiedFor(null);
      setError(e?.message || 'That key did not work.');
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  const reset = useCallback(() => {
    setNumbers(null);
    setVerifiedFor(null);
    setError(null);
  }, []);

  return { numbers, loading, error, verifiedFor, verify, reset };
}

/** Picks the from-number out of the numbers a verified key returned. */
export const FromNumberSelect: React.FC<{
  numbers: OwnedNumber[];
  value: string;
  onChange: (v: string) => void;
}> = ({ numbers, value, onChange }) => {
  const options = numbers.map((n) => ({
    value: n.phone_number,
    label: n.phone_number,
    sublabel: n.messaging_profile_id ? 'Calls + texts' : 'Calls only · no Messaging Profile',
  }));
  // Keep a number already on file selectable even if Telnyx no longer lists it,
  // so opening the form does not silently change it.
  if (value && !options.some((o) => o.value === value)) {
    options.unshift({ value, label: value, sublabel: 'Saved · not found on this account' });
  }

  return (
    <div className="space-y-1.5">
      <RichSelect
        options={options}
        value={value}
        onChange={onChange}
        placeholder="Select the number to call from"
        icon={<Phone />}
        mono
        emptyText="No numbers on this account."
      />
      {numbers.length === 0 && (
        <p className="text-2xs text-amber-400">
          This Telnyx account has no phone numbers yet. Buy one in the Telnyx portal, then verify again.
        </p>
      )}
    </div>
  );
};
