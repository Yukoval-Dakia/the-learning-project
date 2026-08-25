export type ChromiumProbeRecord = {
  schema_version: 1;
  launched: boolean;
  browser: 'chromium';
  version: string | null;
  headless: boolean;
  error: string | null;
};
