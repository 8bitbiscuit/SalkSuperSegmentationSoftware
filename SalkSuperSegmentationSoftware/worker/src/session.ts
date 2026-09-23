// Pure helpers: ids, names, tokens, validation, and the instance's user data.

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** 10 random base32 characters: hostname-safe, ~50 bits. */
export function newSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => BASE32[b & 31]).join('');
}

/** The part of the email before @, made safe as a Linux-ish user name and file prefix. */
export function usernameOf(email: string): string {
  const local = email.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+/, '');
  return local.slice(0, 32) || 'user';
}

export function hostnameFor(template: string, id: string): string {
  if (!template.includes('{id}')) throw new Error('SESSION_HOSTNAME must contain {id}');
  return template.replace('{id}', id);
}

export const tunnelName = (id: string) => `annotate-${id}`;

/** What the desktop's token verifier accepts: HMAC(secret, session id), base64url. */
export async function dcvToken(secret: string, session: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(session)));
  return btoa(String.fromCharCode(...mac)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const REGION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const masksPrefix = (region: string) => `regions/${region}/masks/`;

const MASKS_NAME = /^([A-Za-z0-9._-]+?)_(\d{8}T\d{6})_masks\.tif(?:\.gz)?$/;

/** `jdoe_20260915T101500_masks.tif.gz` -> { user: 'jdoe' }; null for anything else. */
export function parseMasksName(name: string): { user: string } | null {
  const m = MASKS_NAME.exec(name);
  return m ? { user: m[1] } : null;
}

// Every value that lands on the instance goes through this: it is written
// into YAML and read by shell scripts, so no quoting is ever needed.
const SAFE = /^[A-Za-z0-9._@/+=:-]*$/;

export function userData(values: Record<string, string>, secrets: Record<string, string>): string {
  const lines = (vars: Record<string, string>) => Object.entries(vars).map(([k, v]) => {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k) || !SAFE.test(v)) throw new Error(`unsafe user-data value for ${k}`);
    return `      ${k}=${v}`;
  }).join('\n');

  return `#cloud-config
write_files:
  - path: /etc/annotate/session.env
    permissions: '0644'
    content: |
${lines(values)}
  - path: /etc/annotate/secrets.env
    permissions: '0600'
    content: |
${lines(secrets)}
`;
}
