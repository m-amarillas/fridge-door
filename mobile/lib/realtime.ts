import { useEffect, useState } from 'react';
import { supabase } from './supabase';

export type DocumentStatus = 'pending' | 'queued' | 'processing' | 'indexed' | 'failed';

export function useDocumentStatus(documentId: string | null): DocumentStatus | null {
  const [status, setStatus] = useState<DocumentStatus | null>(null);

  useEffect(() => {
    if (!documentId) return;

    // Requires the `documents` table to be added to Supabase Realtime publication:
    // ALTER PUBLICATION supabase_realtime ADD TABLE documents;
    const channel = supabase
      .channel(`doc-${documentId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'documents',
          filter: `id=eq.${documentId}`,
        },
        (payload) => {
          setStatus(payload.new.status as DocumentStatus);
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [documentId]);

  return status;
}
