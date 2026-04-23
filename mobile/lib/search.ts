import type { Document } from './documents';
import { getAuthToken } from './supabase';

export async function searchDocuments(query: string, limit = 10): Promise<Document[]> {
  const base = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  const token = await getAuthToken();
  const res = await fetch(`${base}/search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, limit }),
  });
  if (!res.ok) throw new Error(`Search failed: ${res.status}`);
  const data = await res.json();
  return (data.documents ?? []) as Document[];
}
