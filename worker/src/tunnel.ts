import { need, type Env, type Tunnels } from './env.ts';

interface CfResponse<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
}

const API = 'https://api.cloudflare.com/client/v4';
const zones = new Map<string, Promise<{ zone: string; account: string }>>();

/**
 * One Cloudflare Tunnel per desktop, routed to DCV on the instance
 * (https://localhost:8443), plus the proxied DNS record that points at it.
 * The instance runs cloudflared with the tunnel's token, so it needs no
 * inbound ports and no certificate.
 *
 * Needs only CF_API_TOKEN and DESKTOP_HOSTNAME; the zone and account are
 * looked up. Checked when a tunnel is made, not before: signing in and
 * browsing folders work before there is a domain.
 */
export function cloudflareTunnels(env: Env): Tunnels {
  async function cf<T>(method: string, url: string, body?: unknown): Promise<T> {
    need(env, 'CF_API_TOKEN', 'DESKTOP_HOSTNAME');
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => null) as CfResponse<T> | null;
    if (!res.ok || !data?.success) {
      const why = data?.errors?.map((e) => `${e.code} ${e.message}`).join('; ') || `HTTP ${res.status}`;
      throw new Error(`Cloudflare ${method} ${new URL(url).pathname}: ${why}`);
    }
    return data.result;
  }

  /** The zone the desktop hostnames live in, and its account: the closest parent domain the token can see. */
  function where() {
    const host = env.DESKTOP_HOSTNAME ?? '';
    let p = zones.get(host);
    if (!p) {
      p = (async () => {
        const labels = host.split('.').slice(1);   // drop the label holding {id}
        for (let i = 0; i < labels.length - 1; i++) {
          const name = labels.slice(i).join('.');
          const found = await cf<{ id: string; name: string; account: { id: string } }[]>(
            'GET', `${API}/zones?name=${encodeURIComponent(name)}`);
          const zone = found.find((z) => z.name === name);
          if (zone) return { zone: zone.id, account: zone.account.id };
        }
        throw new Error(`CF_API_TOKEN can't see a Cloudflare zone for ${host.replace('{id}', '…')}`);
      })();
      p.catch(() => zones.delete(host));
      zones.set(host, p);
    }
    return p;
  }
  const tunnelsUrl = async () => `${API}/accounts/${(await where()).account}/cfd_tunnel`;
  const recordsUrl = async () => `${API}/zones/${(await where()).zone}/dns_records`;

  return {
    async create(name, hostname) {
      const tunnels = await tunnelsUrl();
      const tunnel = await cf<{ id: string }>('POST', tunnels, { name, config_src: 'cloudflare' });
      await cf('PUT', `${tunnels}/${tunnel.id}/configurations`, {
        config: {
          ingress: [
            // DCV serves its own self-signed certificate; the tunnel is the trust boundary.
            { hostname, service: 'https://localhost:8443', originRequest: { noTLSVerify: true } },
            { service: 'http_status:404' },
          ],
        },
      });
      await cf('POST', await recordsUrl(), {
        type: 'CNAME', name: hostname, content: `${tunnel.id}.cfargotunnel.com`, proxied: true, comment: name,
      });
      const token = await cf<string>('GET', `${tunnels}/${tunnel.id}/token`);
      return { id: tunnel.id, token };
    },

    async healthy(tunnelId) {
      const tunnel = await cf<{ status: string }>('GET', `${await tunnelsUrl()}/${tunnelId}`);
      return tunnel.status === 'healthy';
    },

    async remove(name, hostname) {
      // Filter again here: an ignored query parameter must never mean "delete everything".
      const records = await recordsUrl();
      const dns = await cf<{ id: string; name: string }[]>('GET', `${records}?name=${encodeURIComponent(hostname)}`);
      for (const r of dns.filter((r) => r.name === hostname)) {
        await cf('DELETE', `${records}/${r.id}`);
      }
      const tunnels = await tunnelsUrl();
      const found = await cf<{ id: string; name: string }[]>(
        'GET', `${tunnels}?name=${encodeURIComponent(name)}&is_deleted=false`);
      for (const t of found.filter((t) => t.name === name)) {
        await cf('DELETE', `${tunnels}/${t.id}/connections`).catch(() => {});  // none once the instance is gone
        await cf('DELETE', `${tunnels}/${t.id}`);
      }
    },
  };
}

/**
 * Without a domain: each desktop opens a quick tunnel, a random
 * *.trycloudflare.com address, and reports it (POST /api/desktop/address);
 * that address becomes the session's hostname and tunnel id. Cloudflare offers
 * quick tunnels for testing, with no uptime guarantee. Setting DESKTOP_HOSTNAME
 * and CF_API_TOKEN switches to named tunnels on your own domain.
 */
export function quickTunnels(): Tunnels {
  return {
    create: async () => ({ id: '', token: '' }),   // the address comes from the desktop once it has one
    async healthy(host) {
      // Cloudflare answers 5xx while nothing is connected behind the address; DCV answers anything else.
      const res = await fetch(`https://${host}/`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) }).catch(() => null);
      await res?.body?.cancel();
      return !!res && res.status < 500;
    },
    remove: async () => {},   // a quick tunnel ends with its desktop
  };
}
