import { createRemoteJWKSet, jwtVerify } from 'jose';
import { HttpError, need, type Env } from './env.ts';

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

/**
 * The signed-in user's email. Cloudflare Access has already made them sign in;
 * this re-checks its signed assertion so nothing reaches the API around it.
 */
export async function identify(req: Request, env: Env): Promise<string> {
  if (env.BACKEND === 'mock') {
    // The pretend cloud has no sign-in. Refuse to run it anywhere but localhost.
    const host = new URL(req.url).hostname;
    if (host !== 'localhost' && host !== '127.0.0.1') {
      throw new Error('BACKEND=mock is for local development only');
    }
    return env.DEV_EMAIL || 'dev.user@example.org';
  }

  need(env, 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD');
  const token = req.headers.get('cf-access-jwt-assertion');
  if (!token) throw new HttpError(401, 'Not signed in.');

  jwks ??= createRemoteJWKSet(new URL(`${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`));
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: env.ACCESS_TEAM_DOMAIN,
      audience: env.ACCESS_AUD,
    });
    if (typeof payload.email !== 'string') throw new Error('no email claim');
    return payload.email.toLowerCase();
  } catch {
    throw new HttpError(401, 'Your sign-in could not be verified. Reload the page to sign in again.');
  }
}
