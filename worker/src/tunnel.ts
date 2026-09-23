import { need, type Env, type Tunnels } from './env.ts';

interface CfResponse<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
}

/**
 * One Cloudflare Tunnel per desktop, routed to DCV on the instance
 * (https://localhost:8443), plus the proxied DNS record that points at it.
 * The instance runs cloudflared with the tunnel's token, so it needs no
 * inbound ports and no certificate.
 */
export function cloudflareTunnels(env: Env): Tunnels {
  need(env, 'CF_API_TOKEN', 'CF_ACCOUNT_ID', 'CF_ZONE_ID');
  const tunnels = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel`;
  const records = `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records`;

  async function cf<T>(method: string, url: string, body?: unknown): Promise<T> {
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

  return {
    async create(name, hostname) {
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
      await cf('POST', records, {
        type: 'CNAME', name: hostname, content: `${tunnel.id}.cfargotunnel.com`, proxied: true, comment: name,
      });
      const token = await cf<string>('GET', `${tunnels}/${tunnel.id}/token`);
      return { id: tunnel.id, token };
    },

    async healthy(tunnelId) {
      const tunnel = await cf<{ status: string }>('GET', `${tunnels}/${tunnelId}`);
      return tunnel.status === 'healthy';
    },

    async remove(name, hostname) {
      // Filter again here: an ignored query parameter must never mean "delete everything".
      const dns = await cf<{ id: string; name: string }[]>('GET', `${records}?name=${encodeURIComponent(hostname)}`);
      for (const r of dns.filter((r) => r.name === hostname)) {
        await cf('DELETE', `${records}/${r.id}`);
      }
      const found = await cf<{ id: string; name: string }[]>(
        'GET', `${tunnels}?name=${encodeURIComponent(name)}&is_deleted=false`);
      for (const t of found.filter((t) => t.name === name)) {
        await cf('DELETE', `${tunnels}/${t.id}/connections`).catch(() => {});  // none once the instance is gone
        await cf('DELETE', `${tunnels}/${t.id}`);
      }
    },
  };
}
