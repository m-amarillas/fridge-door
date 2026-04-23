import { getAuthToken } from './supabase';

export type Document = {
  id: string;
  image_url: string | null;  // pre-signed by the API; null if signing failed
  document_type: string | null;
  status: 'pending' | 'queued' | 'processing' | 'indexed' | 'failed';
  created_at: string;
  ocr_text: string | null;
};

export async function fetchDocuments(limit?: number): Promise<Document[]> {
  const base = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  const url = new URL(`${base}/documents`);
  if (limit !== undefined) url.searchParams.set('limit', String(limit));

  const token = await getAuthToken();
  const res = await fetch(url.toString(), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`Failed to fetch documents: ${res.status}`);

  const data = await res.json();
  return (data.documents ?? []) as Document[];
}
