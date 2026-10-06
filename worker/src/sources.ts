// The session page's picker: which data folder, then down its folders to a
// region, and which of the region's images open. The two data folders are laid
// out differently:
//
//   spida_dev     <brain region>/<region>/<field of view>/DAPI_decon_z0.tif ...
//                 The first folder down that holds CHANNEL's z-planes opens, with those.
//   spatial_data  <experiment>/out/<region>/images/mosaic_DAPI_z3.tif, mosaic_DAPI_z3.decon.tif ...
//                 The annotator ticks which of the region's image stacks open.
//
// Every path is a folder under DATA_PREFIX, and a region's path is its id:
// masks save to <region>/masks/. infra/ lets users into each root
// (data_folders), so keep the two in step.
import { HttpError, type Cloud, type Env } from './env.ts';
import { REGION_ID } from './session.ts';

interface Source {
  name: string;
  root: string;
  layout: 'fields' | 'mosaics';
}

export const SOURCES: Source[] = [
  { name: 'spida_dev', root: 'spida_dev/cellpose_3d_test/patches', layout: 'fields' },
  { name: 'spatial_data', root: 'spatial_data', layout: 'mosaics' },
];

// Names for the spida_dev levels; deeper ones are "Folder".
const FIELD_LEVELS = ['Brain region', 'Region', 'Field of view'];

/** One channel's z-planes in a folder. */
export interface Stack {
  name: string;
  planes: number;
  bytes: number;
}

// mosaic_DAPI_z0.tif, mosaic_DAPI_z1.tif ... are the stack "mosaic_DAPI";
// mosaic_DAPI_z3.decon.tif is "mosaic_DAPI.decon". The desktop turns a name
// back into its files (start-napari.sh), with the z-number before its first ".".
const PLANE = /^([A-Za-z0-9_-]+?)_z\d+((?:\.[A-Za-z0-9_-]+)*?)\.tif$/;

/** The image stacks among a folder's files, by name. */
export function stacks(files: { name: string; size: number }[]): Stack[] {
  const found = new Map<string, Stack>();
  for (const f of files) {
    const m = PLANE.exec(f.name);
    if (!m) continue;
    const s = found.get(m[1] + m[2]) ?? { name: m[1] + m[2], planes: 0, bytes: 0 };
    s.planes++;
    s.bytes += f.size;
    found.set(s.name, s);
  }
  return [...found.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

export interface Region {
  region: string;
  images: string;   // the region's subfolder holding the images; '' when they sit in it
  stacks: Stack[];
  pick: boolean;    // the annotator picks which stacks open; otherwise all of them do
}

/** One step of the picker: a choice of folders to go on with, or a region that opens. */
export type Step = { label: string; folders: { name: string; path: string }[] } | Region;

/** What the picker shows at `path` ('' for the top), read from the bucket as the user. */
export async function browse(env: Env, cloud: Cloud, path: string): Promise<Step> {
  // Not on the setup page: running desktops still need the site for their tokens.
  if (env.DATA_PREFIX) throw new HttpError(503, `DATA_URL is now the bucket itself: change it to s3://${env.BUCKET}/ in the Cloudflare settings.`);
  if (!path) return { label: 'Data', folders: SOURCES.map((s) => ({ name: s.name, path: s.root })) };
  const source = REGION_ID.test(path) ? SOURCES.find((s) => path === s.root || path.startsWith(`${s.root}/`)) : undefined;
  if (!source) throw new HttpError(400, 'Unknown folder.');
  const below = path === source.root ? [] : path.slice(source.root.length + 1).split('/');
  const where = (p: string) => `s3://${env.BUCKET}/${p}/`;

  const choose = (label: string, folders: string[], next = (f: string) => `${path}/${f}`): Step => {
    if (!folders.length) throw new HttpError(404, `There are no folders in ${where(path)}.`);
    return { label, folders: folders.map((f) => ({ name: f, path: next(f) })) };
  };

  if (source.layout === 'fields') {
    const { folders, files } = await cloud.listFolder(path);
    const stack = stacks(files).find((s) => s.name === env.CHANNEL);
    if (stack) return { region: path, images: '', stacks: [stack], pick: false };
    if (!folders.length) throw new HttpError(404, `There are no ${env.CHANNEL} images and no folders in ${where(path)}.`);
    return choose(FIELD_LEVELS[below.length] ?? 'Folder', folders);
  }

  // <experiment>/out/<region>; the picker steps over out/.
  const [experiment, out, region, ...deeper] = below;
  if (!experiment) return choose('Experiment', (await cloud.listFolder(path)).folders, (f) => `${path}/${f}/out`);
  if (out !== 'out' || deeper.length) throw new HttpError(400, 'Unknown folder.');
  if (!region) return choose('Region', (await cloud.listFolder(path)).folders);
  const found = stacks((await cloud.listFolder(`${path}/images`)).files);
  if (!found.length) throw new HttpError(404, `There are no z-plane images (…_z<number>.tif) in ${where(`${path}/images`)}.`);
  return { region: path, images: 'images', stacks: found, pick: true };
}

/** The region at `path`, checked in the bucket as the user. */
export async function openable(env: Env, cloud: Cloud, path: unknown): Promise<Region> {
  const step = typeof path === 'string' && path ? await browse(env, cloud, path) : null;
  if (!step || !('region' in step)) throw new HttpError(400, 'Pick a folder that has images to open.');
  return step;
}

// ponytail: sized for the default r6i.4xlarge (128 GiB). napari holds about
// twice each open z-plane, plus the masks; raise this with instance_type.
const MAX_PLANE_BYTES = 48e9;

/** The stacks a session opens: those the annotator picked, where the region lets them pick. */
export function chosenStacks(region: Region, picked: unknown): string[] {
  if (!region.pick) return region.stacks.map((s) => s.name);
  const names = Array.isArray(picked) ? picked : [];
  const missing = names.filter((n) => !region.stacks.some((s) => s.name === n));
  if (missing.length) throw new HttpError(400, `${missing.join(', ')} is not in ${region.region} any more. Reload the page.`);
  if (!names.length) throw new HttpError(400, 'Pick at least one kind of image to open.');
  const open = region.stacks.filter((s) => names.includes(s.name));   // in the page's order
  const bytes = open.reduce((sum, s) => sum + s.bytes / s.planes, 0);
  if (bytes > MAX_PLANE_BYTES) {
    throw new HttpError(400, `Together those are ${(bytes / 1e9).toFixed(1)} GB a z-plane, more than a desktop's ${MAX_PLANE_BYTES / 1e9} GB. Untick some.`);
  }
  return open.map((s) => s.name);
}
