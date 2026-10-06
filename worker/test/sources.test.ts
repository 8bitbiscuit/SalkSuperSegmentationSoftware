// The picker: from the two data folders down to a region, and what opens there.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Cloud, Env } from '../src/env.ts';
import worker from '../src/index.ts';
import { browse, chosenStacks, openable, stacks, type Region } from '../src/sources.ts';
import { fakeD1 } from './d1.ts';

const env = { BUCKET: 'data', DATA_PREFIX: '', CHANNEL: 'DAPI_decon' } as Env;

const SPIDA = 'spida_dev/cellpose_3d_test/patches';
const REGION = 'spatial_data/202507181027_BICAN-4x1-A10-Q-02_VMSC31910/out/region_UCI-5224';

/** A bucket holding these files, listed a folder at a time as S3 does with a delimiter. */
function bucket(sizes: Record<string, number>): Cloud {
  return {
    async listFolder(path: string) {
      const prefix = path ? `${path}/` : '';
      const folders = new Set<string>();
      const files = [];
      for (const [key, size] of Object.entries(sizes).filter(([k]) => k.startsWith(prefix))) {
        const [name, ...rest] = key.slice(prefix.length).split('/');
        if (rest.length) folders.add(name);
        else files.push({ name, size });
      }
      folders.delete('masks');
      return { folders: [...folders].sort(), files };
    },
  } as Cloud;
}

const cloud = bucket({
  [`${SPIDA}/CBDN/region_UWA-7648/fov_07/DAPI_decon_z0.tif`]: 10,
  [`${SPIDA}/CBDN/region_UWA-7648/fov_07/DAPI_decon_z1.tif`]: 10,
  [`${SPIDA}/CBDN/region_UWA-7648/fov_07/PVALB_decon_z0.tif`]: 10,
  [`${SPIDA}/CBDN/region_UWA-7648/fov_08/PVALB_decon_z0.tif`]: 10,
  [`${REGION}/images/manifest.json`]: 1,
  [`${REGION}/images/mosaic_DAPI_z3.tif`]: 11e9,
  [`${REGION}/images/mosaic_DAPI_z3.decon.tif`]: 22e9,
  [`${REGION}/images/mosaic_GFAP_z3.tif`]: 11e9,
  [`${REGION}/images/mosaic_PolyT_z3.decon.tif`]: 22e9,
  [`${REGION}/cell_by_gene.csv`]: 1,
  'spatial_data/202508011054_BICAN-4x1-A38-E-05_VMSC31910/out/region_UWA-7648/images/mosaic_DAPI_z0.tif': 1,
  'home.ubuntu/notes.txt': 1,
});

test('stacks group a folder\'s z-planes by name, raw and deconvolved apart', () => {
  assert.deepEqual(stacks([
    { name: 'mosaic_DAPI_z3.decon.tif', size: 22 }, { name: 'mosaic_DAPI_z3.tif', size: 11 },
    { name: 'mosaic_DAPI_z4.tif', size: 11 }, { name: 'DAPI_decon_z12.tif', size: 5 },
    { name: 'manifest.json', size: 1 }, { name: 'DAPI_decon_z1.tif.bak', size: 1 }, { name: 'mosaic_DAPI.tif', size: 1 },
    { name: 'bad name_z1.tif', size: 1 },
  ]), [
    { name: 'DAPI_decon', planes: 1, bytes: 5 },
    { name: 'mosaic_DAPI', planes: 2, bytes: 22 },
    { name: 'mosaic_DAPI.decon', planes: 1, bytes: 22 },
  ]);
});

test('the top of the picker is the two data folders', async () => {
  assert.deepEqual(await browse(env, cloud, ''), {
    label: 'Data',
    folders: [{ name: 'spida_dev', path: SPIDA }, { name: 'spatial_data', path: 'spatial_data' }],
  });
});

test('spida_dev goes down its folders to the first that holds CHANNEL\'s images', async () => {
  assert.deepEqual(await browse(env, cloud, SPIDA), { label: 'Brain region', folders: [{ name: 'CBDN', path: `${SPIDA}/CBDN` }] });
  assert.deepEqual((await browse(env, cloud, `${SPIDA}/CBDN/region_UWA-7648`)), {
    label: 'Field of view',
    folders: [{ name: 'fov_07', path: `${SPIDA}/CBDN/region_UWA-7648/fov_07` }, { name: 'fov_08', path: `${SPIDA}/CBDN/region_UWA-7648/fov_08` }],
  });
  assert.deepEqual(await browse(env, cloud, `${SPIDA}/CBDN/region_UWA-7648/fov_07`), {
    region: `${SPIDA}/CBDN/region_UWA-7648/fov_07`, images: '', pick: false,
    stacks: [{ name: 'DAPI_decon', planes: 2, bytes: 20 }],   // only CHANNEL's, as before
  });
  await assert.rejects(browse(env, cloud, `${SPIDA}/CBDN/region_UWA-7648/fov_08`),
    { status: 404, message: `There are no DAPI_decon images and no folders in s3://data/${SPIDA}/CBDN/region_UWA-7648/fov_08/.` });
});

test('spatial_data goes experiment, then region in out/, then the images to pick from', async () => {
  const top = await browse(env, cloud, 'spatial_data');
  assert.equal('label' in top && top.label, 'Experiment');
  assert.deepEqual('folders' in top && top.folders[0],
    { name: '202507181027_BICAN-4x1-A10-Q-02_VMSC31910', path: 'spatial_data/202507181027_BICAN-4x1-A10-Q-02_VMSC31910/out' });
  assert.deepEqual(await browse(env, cloud, 'spatial_data/202507181027_BICAN-4x1-A10-Q-02_VMSC31910/out'),
    { label: 'Region', folders: [{ name: 'region_UCI-5224', path: REGION }] });
  assert.deepEqual(await browse(env, cloud, REGION), {
    region: REGION, images: 'images', pick: true,
    stacks: [
      { name: 'mosaic_DAPI', planes: 1, bytes: 11e9 },
      { name: 'mosaic_DAPI.decon', planes: 1, bytes: 22e9 },
      { name: 'mosaic_GFAP', planes: 1, bytes: 11e9 },
      { name: 'mosaic_PolyT.decon', planes: 1, bytes: 22e9 },
    ],
  });
});

test('a DATA_URL still naming spida_dev\'s folder says what to change it to', async () => {
  await assert.rejects(browse({ ...env, DATA_PREFIX: `${SPIDA}/` }, cloud, ''),
    { status: 503, message: 'DATA_URL is now the bucket itself: change it to s3://data/ in the Cloudflare settings.' });
});

test('only folders of the two layouts can be browsed', async () => {
  for (const bad of ['home.ubuntu', 'spatial_dataX', 'spida_dev', '../spatial_data', `${REGION}/images`,
    'spatial_data/202507181027_BICAN-4x1-A10-Q-02_VMSC31910', 'spatial_data/202507181027_BICAN-4x1-A10-Q-02_VMSC31910/raw']) {
    await assert.rejects(browse(env, cloud, bad), { status: 400 }, bad);
  }
  await assert.rejects(browse(env, cloud, 'spatial_data/none/out'), { status: 404, message: /no folders in s3:\/\/data\/spatial_data\/none\/out\/\./ });
  await assert.rejects(browse(env, cloud, 'spatial_data/none/out/region_X'), { status: 404, message: /no z-plane images/ });
});

test('only a region opens, and a spatial_data region opens what was picked from it', async () => {
  await assert.rejects(openable(env, cloud, 'spatial_data'), { status: 400 });
  await assert.rejects(openable(env, cloud, 42), { status: 400 });
  const region = await openable(env, cloud, REGION);
  assert.deepEqual(chosenStacks(region, ['mosaic_GFAP', 'mosaic_DAPI']), ['mosaic_DAPI', 'mosaic_GFAP']);
  assert.throws(() => chosenStacks(region, []), { status: 400, message: /Pick at least one/ });
  assert.throws(() => chosenStacks(region, null), { status: 400 });
  assert.throws(() => chosenStacks(region, ['mosaic_DAPI', 'mosaic_PolyT']), { status: 400, message: /mosaic_PolyT is not in/ });
  // what fits on a desktop at once: 44 GB a plane does, 55 GB doesn't
  assert.equal(chosenStacks(region, ['mosaic_DAPI.decon', 'mosaic_PolyT.decon']).length, 2);
  assert.throws(() => chosenStacks(region, ['mosaic_DAPI.decon', 'mosaic_GFAP', 'mosaic_PolyT.decon']),
    { status: 400, message: 'Together those are 55.0 GB a z-plane, more than a desktop\'s 48 GB. Untick some.' });
  // spida_dev has no choice: CHANNEL opens whatever was sent
  const field = await openable(env, cloud, `${SPIDA}/CBDN/region_UWA-7648/fov_07`);
  assert.deepEqual(chosenStacks(field as Region, ['mosaic_GFAP']), ['DAPI_decon']);
});

test('the session page\'s calls, against the pretend cloud', async () => {
  const dev = { BACKEND: 'mock', DB: fakeD1() } as Env;
  const call = async (path: string, init?: RequestInit) => {
    const res = await worker.fetch!(new Request(`http://localhost${path}`, init) as never, dev, {} as ExecutionContext);
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const start = (body: unknown) => call('/api/session', { method: 'POST', body: JSON.stringify(body) });
  const region = 'spatial_data/202507181027_BICAN-4x1-A10-Q-02_VMSC31910/out/region_UCI-5224';

  assert.equal((await call('/api/folders?path=')).body.label, 'Data');
  const step = (await call(`/api/folders?path=${encodeURIComponent(region)}`)).body;
  assert.deepEqual(step.stacks.map((s: { name: string }) => s.name),
    ['mosaic_DAPI', 'mosaic_DAPI.decon', 'mosaic_GFAP', 'mosaic_PolyT', 'mosaic_PolyT.decon']);
  assert.equal((await call(`/api/masks?region=${encodeURIComponent(region)}`)).status, 200);

  assert.equal((await start({ region, stacks: [] })).status, 400);
  assert.equal((await start({ region: 'spatial_data', stacks: ['mosaic_DAPI'] })).status, 400);
  const started = await start({ region, stacks: ['mosaic_GFAP', 'mosaic_DAPI.decon'], resume_key: null });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.equal(started.body.session.region, region);
});
