const secretAssignment =
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|cookie|password|secret)\b\s*[:=]\s*([^\s,;]+)/gi;
const bearerToken = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const sensitiveHeader = /\b(authorization|cookie)\b\s*[:=]\s*[^\r\n,;]+/gi;

/** Redacts common credentials and query values before evidence is persisted. */
export function redactSensitiveText(value: string, maxLength = 8_000): string {
  const redacted = value
    .replace(sensitiveHeader, (_match, name: string) => `${name}=[REDACTED]`)
    .replace(bearerToken, 'Bearer [REDACTED]')
    .replace(secretAssignment, (_match, name: string) => `${name}=[REDACTED]`)
    .replace(/([?&][^=&#\s]+)=([^&#\s]*)/g, '$1=[REDACTED]');
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}…[TRUNCATED]` : redacted;
}

/** Recursively redacts string leaves without corrupting structured evidence serialization. */
export function redactSensitiveValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactSensitiveValue(item, seen)]),
  );
}

/** Removes credentials, query values, and fragments while retaining a useful request locator. */
export function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '[REDACTED]');
    url.hash = '';
    return url.toString();
  } catch {
    return redactSensitiveText(value);
  }
}

export function isUrlAllowed(value: string, allowedOrigins: readonly string[]): boolean {
  if (value.startsWith('data:') || value.startsWith('blob:') || value.startsWith('about:'))
    return true;
  try {
    const candidate = new URL(value);
    return allowedOrigins.some((entry) => {
      const allowed = new URL(entry);
      if (candidate.origin !== allowed.origin) return false;
      if (allowed.pathname === '/') return true;
      const allowedPath = allowed.pathname.replace(/\/+$/, '');
      return candidate.pathname === allowedPath || candidate.pathname.startsWith(`${allowedPath}/`);
    });
  } catch {
    return false;
  }
}
