import { useCallback } from 'react';
import { toast } from 'react-toastify';
import { ApiError, leadsApi } from '../../api/client';
import { useApp } from '../../context/AppContext';
import { messageFor } from '../../lib/api';
import { toLead } from '../views/LeadsView';

/**
 * Opens the lead detail modal for any lead id, from screens that do not hold the lead list (the
 * Duplicates screen): the lead is read fresh and registered with the context the modal reads from.
 */
export function useOpenLead(): (leadId: string) => Promise<void> {
  const { registerExternalLeads, setSelectedLeadId } = useApp();
  return useCallback(
    async (leadId: string) => {
      try {
        const lead = await leadsApi.get(leadId);
        registerExternalLeads([toLead(lead)]);
        setSelectedLeadId(leadId);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'LEAD_MERGED') toast.info('This lead was merged into another lead.');
        else toast.error(messageFor(e));
      }
    },
    [registerExternalLeads, setSelectedLeadId],
  );
}
