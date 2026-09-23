export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;

  BACKEND: 'aws' | 'mock';
  DEV_EMAIL?: string;
  SESSION_HOSTNAME: string;
  IDLE_MINUTES: string;

  AWS_REGION?: string;
  LAUNCH_TEMPLATE_ID?: string;
  BUCKET?: string;
  CF_ACCOUNT_ID?: string;
  CF_ZONE_ID?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;

  // secrets
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  CF_API_TOKEN?: string;
  DCV_TOKEN_SECRET?: string;
}

/** An error whose message is safe to show the user. */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

export function need(env: Env, ...names: (keyof Env)[]): void {
  const missing = names.filter((n) => !env[n]);
  if (missing.length) throw new Error(`Worker is missing configuration: ${missing.join(', ')}`);
}

// ---- what the Worker needs from AWS and from Cloudflare --------------------

export interface Instance {
  id: string;
  session: string;   // the Session tag
  state: string;     // pending | running | stopping | stopped
}

export interface MaskFile {
  key: string;
  size: number;
  modified: string;  // ISO 8601
}

export interface LaunchSpec {
  session: string;
  email: string;
  username: string;
  region: string;
  userData: string;
}

export interface Cloud {
  launch(spec: LaunchSpec): Promise<string>;
  /** Instances that are not shutting down or terminated; all of them, or one session's. */
  instances(session?: string): Promise<Instance[]>;
  requestStop(instanceId: string): Promise<void>;
  terminate(instanceIds: string[]): Promise<void>;
  listMasks(region: string): Promise<MaskFile[]>;
}

export interface Tunnels {
  /** Tunnel routed to the desktop, plus its DNS record. Returns the tunnel id and connector token. */
  create(name: string, hostname: string): Promise<{ id: string; token: string }>;
  healthy(tunnelId: string): Promise<boolean>;
  /** Idempotent: finds the tunnel and record by name, so it also clears half-made ones. */
  remove(name: string, hostname: string): Promise<void>;
}

export interface Backend {
  cloud: Cloud;
  tunnels: Tunnels;
  desktopUrl(hostname: string, session: string, token: string): string;
}
