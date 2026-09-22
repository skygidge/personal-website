const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

export function createAgentKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `amb_live_${base64Url(bytes)}`;
}

export async function keyLookupHash(secret: string, apiKey: string): Promise<string> {
  return hmac(secret, `api-key:${apiKey}`);
}

export interface AuthenticatedAgent {
  agentId: string;
  displayName: string;
  ipHash: string;
}

export async function authenticateAgent(
  db: D1Database,
  secret: string,
  apiKey: string
): Promise<AuthenticatedAgent | null> {
  const keyHash = await keyLookupHash(secret, apiKey);
  const agent = await db.prepare(
    "SELECT agent_id, display_name, ip_hash FROM agents WHERE key_hash = ? AND revoked_at IS NULL"
  ).bind(keyHash).first<{ agent_id: string; display_name: string; ip_hash: string }>();

  // Legacy day-only hashes cannot be recovered into a registration origin.
  return agent && /^origin-v1:[A-Za-z0-9_-]{43}$/u.test(agent.ip_hash)
    ? { agentId: agent.agent_id, displayName: agent.display_name, ipHash: agent.ip_hash }
    : null;
}

export function bearerToken(authorization: string | null): string | null {
  const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/u);
  return match?.[1] ?? null;
}

export function normalizeIp(address: string | null): string | null {
  const value = address?.trim();
  if (!value || value.includes("%")) return null;

  const ipv4 = value.split(".");
  if (ipv4.length === 4 && ipv4.every((part) => /^\d{1,3}$/u.test(part))) {
    const octets = ipv4.map(Number);
    if (octets.every((octet) => octet <= 255)) return octets.join(".");
  }

  if (!value.includes(":")) return null;
  try {
    const hostname = new URL(`http://[${value}]`).hostname.toLowerCase();
    return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  } catch {
    return null;
  }
}

export function utcDay(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

export async function ipLookupHash(secret: string, normalizedIp: string, timestampMs: number): Promise<string> {
  return hmac(secret, `ip:${utcDay(timestampMs)}:${normalizedIp}`);
}

export async function originLookupHash(secret: string, normalizedIp: string): Promise<string> {
  return `origin-v1:${await hmac(secret, `registration-origin:${normalizedIp}`)}`;
}

export async function originQuotaHash(secret: string, originHash: string, timestampMs: number): Promise<string> {
  return hmac(secret, `posting-ip:${utcDay(timestampMs)}:${originHash}`);
}
