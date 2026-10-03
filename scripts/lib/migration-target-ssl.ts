/** Only an unambiguous loopback hostname permits implicit plaintext. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // postgres-js decodes and splits multihost authorities before URL parsing.
  // A suffix on the entire list must not authorize its remote endpoints.
  if (/[,%]/.test(host)) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Preserve explicit sslmode=disable; otherwise require TLS for remote/ambiguous targets. */
export function migrationTargetSsl(targetUrl: string): false | 'require' {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return 'require';
  }
  if (parsed.searchParams.get('sslmode') === 'disable') return false;

  // Match the driver's authority boundary, including its first-@ split. WHATWG
  // URL instead uses the last @, so checking only parsed.hostname is insufficient.
  // Ambiguous/encoded/multiple endpoints require TLS rather than guessing which
  // server the driver will reach. No credentials are logged or returned.
  const authority = targetUrl.slice(targetUrl.indexOf('://') + 3).split(/[?/]/)[0];
  const driverHost = authority.slice(authority.indexOf('@') + 1);
  if (/[@,%#]/.test(driverHost)) return 'require';
  return isLoopbackHost(parsed.hostname) ? false : 'require';
}
