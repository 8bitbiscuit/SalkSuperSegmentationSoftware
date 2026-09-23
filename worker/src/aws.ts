import { AwsClient } from 'aws4fetch';
import { need, type Cloud, type Creds, type Env, type Instance, type MaskFile } from './env.ts';
import { masksPrefix } from './session.ts';
import { all, at, parseXml, text, type XmlNode } from './xml.ts';

// Everything but shutting-down and terminated: an instance that still costs
// money or can still be reached.
const ALIVE = ['pending', 'running', 'stopping', 'stopped'];

// Made by infra/ under this name, so the site needs no id for it.
export const LAUNCH_TEMPLATE = 'annotate-desktop';

const credsCache = new Map<string, Creds & { expiresAt: number }>();

/** AWS role session names allow letters, digits and + = , . @ - only. */
export const sessionName = (email: string) => email.replace(/[^\w+=,.@-]/g, '-').slice(0, 64);

/**
 * AWS credentials in the signed-in user's own name: their Cognito ID token,
 * exchanged with STS for the user role. CloudTrail shows every call they
 * make as assumed-role/<role>/<their email>. Needs no AWS keys of its own.
 */
export async function userCredentials(env: Env, email: string, idToken: string): Promise<Creds> {
  need(env, 'AWS_REGION', 'AWS_ROLE_ARN');
  const cached = credsCache.get(email);
  if (cached && cached.expiresAt - Date.now() > 10 * 60_000) return cached;

  const res = await fetch(`https://sts.${env.AWS_REGION}.amazonaws.com/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body: new URLSearchParams({
      Action: 'AssumeRoleWithWebIdentity', Version: '2011-06-15', RoleArn: env.AWS_ROLE_ARN!,
      RoleSessionName: sessionName(email), WebIdentityToken: idToken, DurationSeconds: '3600',
    }).toString(),
  });
  const doc = parseXml(await res.text());
  if (!res.ok) {
    const err = at(doc, 'ErrorResponse', 'Error');
    throw new Error(`AWS would not sign in ${email}: ${text(err, 'Code')} ${text(err, 'Message')}`.trim());
  }
  const c = at(doc, 'AssumeRoleWithWebIdentityResponse', 'AssumeRoleWithWebIdentityResult', 'Credentials');
  const creds = {
    accessKeyId: text(c, 'AccessKeyId'),
    secretAccessKey: text(c, 'SecretAccessKey'),
    sessionToken: text(c, 'SessionToken'),
    expiresAt: Date.parse(text(c, 'Expiration')),
  };
  credsCache.set(email, creds);
  return creds;
}

/** EC2 and S3 through their plain HTTP APIs, signed with aws4fetch, as whoever `creds` belong to. */
export function awsCloud(env: Env, creds: Creds): Cloud {
  need(env, 'AWS_REGION', 'BUCKET');
  const region = env.AWS_REGION!;
  const aws = new AwsClient({ ...creds, region });
  const channel = env.CHANNEL!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const imageName = new RegExp(`^${channel}_z\\d+\\.tif$`);   // e.g. DAPI_decon_z0.tif

  /** Every object (and, with a delimiter, every subfolder) under a prefix, across pages. */
  async function list(prefix: string, delimiter?: string) {
    const files: MaskFile[] = [];
    const folders: string[] = [];
    let token = '';
    do {
      const url = new URL(`https://${env.BUCKET}.s3.${region}.amazonaws.com/`);
      url.searchParams.set('list-type', '2');
      url.searchParams.set('prefix', prefix);
      if (delimiter) url.searchParams.set('delimiter', delimiter);
      if (token) url.searchParams.set('continuation-token', token);
      const res = await aws.fetch(url.toString());
      const doc = parseXml(await res.text());
      if (!res.ok) throw new Error(`S3 list failed: ${text(doc, 'Error', 'Code')} ${text(doc, 'Error', 'Message')}`.trim());
      const result = at(doc, 'ListBucketResult');
      for (const c of all(result, 'Contents')) {
        files.push({ key: text(c, 'Key'), size: Number(text(c, 'Size')), modified: text(c, 'LastModified') });
      }
      for (const p of all(result, 'CommonPrefixes')) folders.push(text(p, 'Prefix'));
      token = text(result, 'IsTruncated') === 'true' ? text(result, 'NextContinuationToken') : '';
    } while (token);
    return { files, folders };
  }

  async function ec2(action: string, params: Record<string, string>): Promise<XmlNode> {
    const res = await aws.fetch(`https://ec2.${region}.amazonaws.com/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: new URLSearchParams({ Action: action, Version: '2016-11-15', ...params }).toString(),
    });
    const doc = parseXml(await res.text());
    if (!res.ok) {
      const err = at(doc, 'Response', 'Errors', 'Error');
      throw new Error(`EC2 ${action} failed: ${text(err, 'Code')} ${text(err, 'Message')}`.trim());
    }
    return doc;
  }

  return {
    async launch(spec) {
      const tags: Record<string, string> = {
        App: 'annotate',
        Session: spec.session,
        Owner: spec.email,
        Region: spec.region,
        Name: `annotate ${spec.username} ${spec.region}`,
      };
      const doc = await ec2('RunInstances', {
        'LaunchTemplate.LaunchTemplateName': LAUNCH_TEMPLATE,
        MinCount: '1',
        MaxCount: '1',
        ClientToken: spec.session,   // a retried request can't launch twice
        UserData: btoa(spec.userData),
        'TagSpecification.1.ResourceType': 'instance',
        ...numbered('TagSpecification.1.Tag', tags),
      });
      const id = text(doc, 'RunInstancesResponse', 'instancesSet', 'item', 'instanceId');
      if (!id) throw new Error('EC2 RunInstances returned no instance id');
      return id;
    },

    async instances(session) {
      const filters: Record<string, string[]> = { 'tag:App': ['annotate'], 'instance-state-name': ALIVE };
      if (session) filters['tag:Session'] = [session];
      const params: Record<string, string> = {};
      Object.entries(filters).forEach(([name, values], i) => {
        params[`Filter.${i + 1}.Name`] = name;
        values.forEach((v, j) => { params[`Filter.${i + 1}.Value.${j + 1}`] = v; });
      });

      const found: Instance[] = [];
      let next = '';
      do {
        const doc = at(await ec2('DescribeInstances', next ? { ...params, NextToken: next } : params),
          'DescribeInstancesResponse');
        for (const reservation of all(at(doc, 'reservationSet'), 'item')) {
          for (const i of all(at(reservation, 'instancesSet'), 'item')) {
            const tags = Object.fromEntries(all(at(i, 'tagSet'), 'item').map((t) => [text(t, 'key'), text(t, 'value')]));
            found.push({ id: text(i, 'instanceId'), session: tags.Session ?? '', state: text(i, 'instanceState', 'name') });
          }
        }
        next = text(doc, 'nextToken');
      } while (next);
      return found;
    },

    async requestStop(instanceId) {
      // The instance reads its own tags from instance metadata and shuts down
      // cleanly: napari saves, the masks sync to S3, then it powers off.
      await ec2('CreateTags', { 'ResourceId.1': instanceId, 'Tag.1.Key': 'Stop', 'Tag.1.Value': 'requested' });
    },

    async terminate(instanceIds) {
      if (!instanceIds.length) return;
      await ec2('TerminateInstances', Object.fromEntries(instanceIds.map((id, i) => [`InstanceId.${i + 1}`, id])));
    },

    async listMasks(regionId) {
      return (await list(masksPrefix(env.DATA_PREFIX, regionId))).files;
    },

    async listFolders(path) {
      const prefix = `${env.DATA_PREFIX ?? ''}${path ? `${path}/` : ''}`;
      const { files, folders } = await list(prefix, '/');
      return {
        folders: folders.map((f) => f.slice(prefix.length, -1)).filter((f) => f && f !== 'masks'),
        images: files.filter((f) => imageName.test(f.key.slice(prefix.length))).length,
      };
    },
  };
}

/** {App: 'x'} -> {'<prefix>.1.Key': 'App', '<prefix>.1.Value': 'x'} */
function numbered(prefix: string, tags: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  Object.entries(tags).forEach(([k, v], i) => {
    out[`${prefix}.${i + 1}.Key`] = k;
    out[`${prefix}.${i + 1}.Value`] = v;
  });
  return out;
}
