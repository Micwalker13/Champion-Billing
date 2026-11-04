/**
 * Largest file a user can upload, in MB. Vercel rejects any request body over 4.5 MB before
 * it reaches the app, so the default there is 4 MB; elsewhere 15 MB. MAX_UPLOAD_MB overrides.
 */
export function maxUploadMb(): number {
  const v = Number(process.env.MAX_UPLOAD_MB);
  return v > 0 ? v : process.env.VERCEL ? 4 : 15;
}
