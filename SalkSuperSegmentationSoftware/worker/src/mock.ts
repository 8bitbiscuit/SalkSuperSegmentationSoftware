// A pretend cloud for local development (BACKEND=mock). Desktops "boot" in a
// few seconds, the tunnel turns healthy a little later, and a session that is
// ended properly leaves a masks file behind, so the whole flow can be clicked
// through with no AWS or Cloudflare account. State lives in memory for as long
// as `wrangler dev` runs.
import type { Backend, Instance, MaskFile } from './env.ts';
import { masksPrefix } from './session.ts';

const BOOT_MS = 5_000;       // pending -> running
const READY_MS = 10_000;     // tunnel healthy (DCV and napari up)
const SHUTDOWN_MS = 8_000;   // Stop tag -> saved, synced, terminated

interface MockInstance extends Instance {
  launchedAt: number;
  stopAt?: number;
  username: string;
  region: string;
}

const instances = new Map<string, MockInstance>();
const tunnels = new Map<string, string>();   // tunnel id -> session id
const masks = new Map<string, MaskFile[]>();

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').slice(0, 15);

function masksFor(region: string): MaskFile[] {
  if (!masks.has(region)) {
    const day = 86_400_000;
    const file = (user: string, ago: number, size: number): MaskFile => ({
      key: `${masksPrefix(region)}${user}_${stamp(Date.now() - ago)}_masks.tif.gz`,
      size,
      modified: new Date(Date.now() - ago).toISOString(),
    });
    masks.set(region, [file('alice', 3 * day, 48e6), file('bob', 9 * day, 131e6)]);
  }
  return masks.get(region)!;
}

function tick(now = Date.now()) {
  for (const i of instances.values()) {
    if (i.state === 'pending' && now - i.launchedAt > BOOT_MS) i.state = 'running';
    if (i.stopAt && i.state !== 'terminated' && now - i.stopAt > SHUTDOWN_MS) {
      i.state = 'terminated';
      // What the real instance's final save and sync would leave in S3.
      masksFor(i.region).push({
        key: `${masksPrefix(i.region)}${i.username}_${stamp(i.launchedAt)}_masks.tif.gz`,
        size: 5e6 + Math.round((now - i.launchedAt) * 1e3),
        modified: new Date(now).toISOString(),
      });
    }
  }
}

export const mockBackend: Backend = {
  cloud: {
    async launch(spec) {
      const id = `i-mock${spec.session}`;
      instances.set(id, {
        id, session: spec.session, state: 'pending', launchedAt: Date.now(),
        username: spec.username, region: spec.region,
      });
      return id;
    },
    async instances(session) {
      tick();
      return [...instances.values()]
        .filter((i) => i.state !== 'terminated' && (!session || i.session === session))
        .map(({ id, session, state }) => ({ id, session, state }));
    },
    async requestStop(instanceId) {
      const i = instances.get(instanceId);
      if (i && !i.stopAt) i.stopAt = Date.now();
    },
    async terminate(instanceIds) {
      for (const id of instanceIds) {
        const i = instances.get(id);
        if (i) i.state = 'terminated';
      }
    },
    async listMasks(region) {
      tick();
      return [...masksFor(region)];
    },
  },

  tunnels: {
    async create(name) {
      const id = `mock-${name}`;
      tunnels.set(id, name.replace(/^annotate-/, ''));
      return { id, token: 'mock-tunnel-token' };
    },
    async healthy(tunnelId) {
      tick();
      const session = tunnels.get(tunnelId);
      const i = [...instances.values()].find((i) => i.session === session);
      return !!i && i.state === 'running' && Date.now() - i.launchedAt > READY_MS;
    },
    async remove(name) {
      tunnels.delete(`mock-${name}`);
    },
  },

  desktopUrl: (_hostname, session, token) =>
    `/api/dev/desktop?session=${encodeURIComponent(session)}&authToken=${encodeURIComponent(token)}`,
};

/** Stands in for the DCV web client. */
export function mockDesktopPage(url: URL): Response {
  const session = url.searchParams.get('session') ?? '';
  const i = [...instances.values()].find((i) => i.session === session);
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const body = i && i.state !== 'terminated'
    ? `<p>Session <code>${esc(session)}</code>: napari would be open here on
         <code>/session/${esc(i.region)}</code>, running as <code>USER=${esc(i.username)}</code>.</p>
       <p>In production this tab is the Amazon DCV web client, reached through the session's Cloudflare Tunnel.</p>`
    : `<p>Session <code>${esc(session)}</code> is not running.</p>`;
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mock desktop</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 16px}</style>
<h1>Mock desktop</h1>${body}`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}
