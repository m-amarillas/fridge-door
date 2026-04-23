import { useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';

export type DocumentStatus = 'pending' | 'queued' | 'processing' | 'indexed' | 'failed';
export type ActionsStatus = 'analyzing' | 'ready' | 'failed' | null;

// Single subscription per document. Using a random instance suffix prevents the
// "cannot add callbacks after subscribe()" error that occurs when the Supabase
// client finds an existing subscribed channel with the same name (e.g. StrictMode
// double-mount or navigating back before the previous cleanup completes).
export function useDocumentRealtime(documentId: string | null): {
  status: DocumentStatus | null;
  actionsStatus: ActionsStatus;
} {
  const [status, setStatus] = useState<DocumentStatus | null>(null);
  const [actionsStatus, setActionsStatus] = useState<ActionsStatus>(null);
  const instanceId = useRef(Math.random().toString(36).slice(2));

  useEffect(() => {
    if (!documentId) return;

    // Requires the `documents` table to be added to Supabase Realtime publication:
    // ALTER PUBLICATION supabase_realtime ADD TABLE documents;
    const channel = supabase
      .channel(`doc-${documentId}-${instanceId.current}`)
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
          setActionsStatus(payload.new.actions_status as ActionsStatus);
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [documentId]);

  return { status, actionsStatus };
}
