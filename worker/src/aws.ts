import { AwsClient } from 'aws4fetch';
import { need, type Cloud, type Env, type Instance, type MaskFile } from './env.ts';
import { masksPrefix } from './session.ts';
import { all, at, parseXml, text, type XmlNode } from './xml.ts';

// Everything but shutting-down and terminated: an instance that still costs
// money or can still be reached.
const ALIVE = ['pending', 'running', 'stopping', 'stopped'];

/** EC2 and S3 through their plain HTTP APIs, signed with aws4fetch. */
export function awsCloud(env: Env): Cloud {
  need(env, 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'LAUNCH_TEMPLATE_ID', 'BUCKET');
  const region = env.AWS_REGION!;
  const aws = new AwsClient({
    accessKeyId: env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY!,
    region,
  });

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
        'LaunchTemplate.LaunchTemplateId': env.LAUNCH_TEMPLATE_ID!,
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
      const prefix = masksPrefix(regionId);
      const files: MaskFile[] = [];
      let token = '';
      do {
        const url = new URL(`https://${env.BUCKET}.s3.${region}.amazonaws.com/`);
        url.searchParams.set('list-type', '2');
        url.searchParams.set('prefix', prefix);
        if (token) url.searchParams.set('continuation-token', token);
        const res = await aws.fetch(url.toString());
        const doc = parseXml(await res.text());
        if (!res.ok) throw new Error(`S3 list failed: ${text(doc, 'Error', 'Code')} ${text(doc, 'Error', 'Message')}`.trim());
        const result = at(doc, 'ListBucketResult');
        for (const c of all(result, 'Contents')) {
          files.push({ key: text(c, 'Key'), size: Number(text(c, 'Size')), modified: text(c, 'LastModified') });
        }
        token = text(result, 'IsTruncated') === 'true' ? text(result, 'NextContinuationToken') : '';
      } while (token);
      return files;
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
