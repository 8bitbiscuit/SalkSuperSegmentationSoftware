// The site's settings come from the Cloudflare dashboard. This checks which
// required ones are missing, and derives the rest, so the dashboard only
// needs what can't be worked out.
import type { Env } from './env.ts';

export const REQUIRED = [
  'DATA_URL', 'COGNITO_USER_POOL_ID', 'COGNITO_CLIENT_ID', 'COGNITO_CLIENT_SECRET', 'AWS_ROLE_ARN',
] as const;

/** s3://bucket/some/folder/ -> { bucket, prefix: 'some/folder/' }; null if it isn't one. */
export function parseDataUrl(url: string): { bucket: string; prefix: string } | null {
  const m = /^s3:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])(?:\/(.*))?$/.exec(url.trim());
  if (!m) return null;
  const prefix = (m[2] ?? '').replace(/^\/+/, '');
  return { bucket: m[1], prefix: prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix };
}

/** Required settings that are missing or malformed, by name. Empty when the site is ready. */
export function missingSettings(env: Env): string[] {
  if (env.BACKEND === 'mock') return [];
  const missing: string[] = REQUIRED.filter((k) => !env[k]?.trim());
  if (env.DATA_URL && !parseDataUrl(env.DATA_URL)) missing.push('DATA_URL (must look like s3://bucket/folder/)');
  if (env.COGNITO_USER_POOL_ID && !/^[a-z]{2}(-[a-z]+)+-\d_\w+$/.test(env.COGNITO_USER_POOL_ID.trim())) {
    missing.push('COGNITO_USER_POOL_ID (must look like us-west-2_AbC123xyz)');
  }
  return missing;
}

/** The env with defaults and derived values filled in. */
export function withSettings(env: Env): Env {
  const mock = env.BACKEND === 'mock';
  const data = parseDataUrl(env.DATA_URL ?? (mock ? 's3://mock-bucket/spida_dev/cellpose_3d_test/patches/' : ''));
  return {
    ...env,
    BUCKET: data?.bucket,
    DATA_PREFIX: data?.prefix ?? '',
    CHANNEL: env.CHANNEL?.trim() || 'DAPI_decon',
    IDLE_MINUTES: env.IDLE_MINUTES?.trim() || '30',
    AWS_REGION: env.AWS_REGION?.trim() || env.COGNITO_USER_POOL_ID?.split('_')[0] || 'us-west-2',
    DESKTOP_HOSTNAME: env.DESKTOP_HOSTNAME?.trim() || (mock ? '{id}.localhost' : undefined),
  };
}

/** What the site shows until it has its settings. */
export function setupPage(missing: string[]): Response {
  const items = missing.map((m) => `<li><code>${m.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`)}</code></li>`).join('');
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Setup · Segmentation desktops</title>
<style>body{font:16px/1.55 system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 16px}code{background:#eee;padding:1px 5px;border-radius:4px}</style>
<h1>Almost there</h1>
<p>The site is running, but it doesn't know where your data is or how people sign in yet. It still needs:</p>
<ul>${items}</ul>
<p>Add them in the Cloudflare dashboard: <strong>Workers &amp; Pages → annotate → Settings → Variables and Secrets</strong>
(<code>COGNITO_CLIENT_SECRET</code> as a secret). <code>terraform output</code> in the project's <code>infra/</code>
folder prints every value. Then reload this page.</p>`, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
