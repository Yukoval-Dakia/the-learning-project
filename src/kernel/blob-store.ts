/** Byte storage contract; credentials and the S3/R2 implementation belong to server. */
export interface BlobStore {
  put(key: string, body: Uint8Array, contentType?: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}
