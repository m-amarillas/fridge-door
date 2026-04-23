import { getAuthToken } from './supabase';

export type UploadResult = {
  text: string;
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
  if (data.error) {
    throw new Error(`OCR error: ${data.error}`);
  }

  return { text: data.text };
}
