import { getAuthToken } from './supabase';

export type UploadResult = {
  document_id: string;
};

export type Action = {
  id: string;
  action_type: 'calendar_event' | 'task' | 'reminder' | 'note';
  status: 'suggested' | 'accepted' | 'dismissed' | 'completed';
  payload: Record<string, unknown>;
  created_at: string;
};

export type ActionsResponse = {
  document_id: string;
  actions_status: 'analyzing' | 'ready' | 'failed' | null;
  actions: Action[];
};

export async function uploadDocument(imageUri: string): Promise<UploadResult> {
  const formData = new FormData();

  // React Native FormData accepts { uri, name, type } at runtime even though
  // TypeScript types don't reflect this — cast required.
  formData.append('file', {
    uri: imageUri,
    name: 'document.jpg',
    type: 'image/jpeg',
  } as unknown as Blob);

  const token = await getAuthToken();

  // Do NOT set Content-Type manually — fetch sets it automatically with the
  // correct multipart boundary when the body is FormData.
  const response = await fetch(`${process.env.EXPO_PUBLIC_API_BASE_URL ?? ''}/documents`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Upload failed ${response.status}: ${text}`);
  }

  const data = await response.json();
  return { document_id: data.document_id };
}

export async function fetchActions(documentId: string): Promise<ActionsResponse> {
  const base = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  const token = await getAuthToken();
  const res = await fetch(`${base}/documents/${documentId}/actions`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`Failed to fetch actions: ${res.status}`);
  return res.json() as Promise<ActionsResponse>;
}
