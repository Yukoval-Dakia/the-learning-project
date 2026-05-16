// Phase 1c.2 Vision MVP — asset upload + cached thumbnail helpers.
//
// /api/assets needs the x-internal-token header, so plain `<img src="/api/assets/.../content">`
// won't work without server-side proxy. Until we add a content endpoint, the
// UI uses uploadAsset to send via apiFetch (FormData; browser sets the
// multipart boundary because apiFetch only injects content-type for string
// bodies).

import { apiFetch } from './api';

export interface UploadedAsset {
  id: string;
  storage_key: string;
  mime_type: string;
  byte_size: number;
  sha256: string;
}

export async function uploadAsset(file: File): Promise<UploadedAsset> {
  const form = new FormData();
  form.append('file', file);
  const res = await apiFetch('/api/assets', { method: 'POST', body: form });
  return (await res.json()) as UploadedAsset;
}
