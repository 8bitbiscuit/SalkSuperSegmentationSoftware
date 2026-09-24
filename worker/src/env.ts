export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;

  // ---- set in the Cloudflare dashboard: Settings -> Variables and Secrets ----
  // `terraform output` in infra/ prints the first five.
  DATA_URL?: string;               // s3://bucket/folder/ holding the brain regions
  COGNITO_USER_POOL_ID?: string;   // e.g. us-west-2_AbC123xyz
  COGNITO_CLIENT_ID?: string;
  COGNITO_CLIENT_SECRET?: string;  // secret
  AWS_ROLE_ARN?: string;           // the role signed-in users act through
  // Desktops, once there is a domain on Cloudflare:
  CF_API_TOKEN?: string;           // secret
  DESKTOP_HOSTNAME?: string;       // e.g. annotate-{id}.example.org; unset: quick tunnels (tunnel.ts)
  // Optional:
  CHANNEL?: string;                // default DAPI_decon: images are <folder>/<CHANNEL>_z<N>.tif
  IDLE_MINUTES?: string;           // default 30
  AWS_REGION?: string;             // default: the user pool's region

  // Local development only (npm run dev):
  BACKEND?: 'mock';
  DEV_EMAIL?: string;

  // ---- filled in by settings.ts from the above ----
  BUCKET?: string;
  DATA_PREFIX?: string;            // folder in the bucket; ends in "/" (or is "")
}

export interface Creds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
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
  /** Subfolders of <DATA_PREFIX><path>/ (not masks/), and how many channel images sit in it. */
  listFolders(path: string): Promise<{ folders: string[]; images: number }>;
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
