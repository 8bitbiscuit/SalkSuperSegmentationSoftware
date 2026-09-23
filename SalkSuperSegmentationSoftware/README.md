# Segmentation desktops

Annotators sign in to a website, pick a region, and get their own cloud
desktop with napari open on it. They paint masks in the browser; masks save
to S3 every few minutes and when the session ends. The desktop shuts itself
down when they're done or walk away.

- **`site/`** is the Jekyll website: the session panel and the annotator guide.
- **`worker/`** is a Cloudflare Worker that serves the site and runs sessions.
  It launches EC2 desktops and makes a Cloudflare Tunnel for each one.
- **`desktop/`** is what runs on each desktop: `open_project.py` (the Anvil
  script, which now also saves on exit), plus the boot, sync and shutdown
  scripts.
- **`ami/`** (Packer) and **`infra/`** (Terraform, us-west-2) build the AWS side.

[PLAN.md](PLAN.md) explains the design and the reasons behind it.

## Run it locally

You need Ruby 3.1+ with Bundler, Node 22.18+ and `make`.

```sh
make install   # Jekyll gems and the Worker's npm packages
make serve     # the Jekyll site alone, with live reload: http://localhost:4000
make dev       # the site plus the session API: http://localhost:8787
make test      # Worker tests and type-check
```

`make serve` is enough for editing pages. The session panel there says the
API isn't available, because Jekyll only serves files.

`make dev` rebuilds the site as you edit and serves it with the real Worker
code, using a pretend cloud (`worker/src/mock.ts`) and no sign-in:

- A desktop "boots" in about 10 seconds, and **Open desktop** shows a
  placeholder page.
- Ending a session adds a masks file to the resume list, as the real
  desktop's final save would.
- The pretend cloud forgets everything when wrangler restarts, which
  includes whenever you edit Worker code. Session history lives in a local
  D1 database under `worker/.wrangler/` and survives restarts.
- To act as someone else, put `DEV_EMAIL=someone@example.org` in
  `worker/.dev.vars` and restart.
- To run the 10-minute cron by hand:
  `curl "http://localhost:8787/__scheduled?cron=*/10+*+*+*+*"`
- To add a region to the picker, edit `site/_data/regions.yml`.

The desktop tests run the real napari script and the watchdog. They need
napari installed (`pip install -r desktop/requirements.txt pytest`), then
`make test-desktop`. On a Linux machine with no display, use
`xvfb-run -a make test-desktop`.

## Deploy

Steps 1–3 can happen now. Steps 4–6 need the domain decision.

### 1. AWS

```sh
cd infra
cp terraform.tfvars.example terraform.tfvars   # set bucket_name
terraform init && terraform apply
aws iam create-access-key --user-name annotate-worker     # for the Worker, step 5
aws iam create-access-key --user-name annotate-lab-sync   # for the lab server, step 3
```

### 2. The desktop image

In GitHub, set the repository variable `AWS_AMI_BUILD_ROLE_ARN` to
`terraform output ami_build_role_arn`, then run the **Build desktop AMI**
workflow. It builds the image and points `/annotate/ami` at it, so new
sessions boot it. Run it again whenever `desktop/` or `ami/` changes.

### 3. Data

From the lab server, with the `annotate-lab-sync` keys:

```sh
aws s3 sync /path/to/region_UCI-5224/images s3://BUCKET/regions/region_UCI-5224/images/
aws s3 sync /path/to/region_UCI-5224/masks  s3://BUCKET/regions/region_UCI-5224/masks/    # to resume existing work
aws s3 sync s3://BUCKET/regions/region_UCI-5224/masks/ /path/to/region_UCI-5224/masks/    # pull masks back
```

Add each region to `site/_data/regions.yml`. A masks file only appears in
the resume list if its name has the form `<user>_<YYYYmmddTHHMMSS>_masks.tif.gz`.
That is how `open_project.py` names them.

### 4. Cloudflare (once the domain is chosen)

1. The domain's zone must be on Cloudflare. Pick hostnames for the site
   (e.g. `annotate.example.org`) and for desktops (e.g. `annotate-{id}.example.org`).
   A desktop hostname should be one level below the zone, so the free
   certificate covers it.
2. **Zero Trust → Settings → Authentication:** add **One-time PIN** as a
   login method.
3. **Zero Trust → Access → Applications → Add → Self-hosted:**
   - Hostnames: the site hostname and the desktop hostnames (a wildcard).
   - Policy: Allow, Include **Emails ending in** `@your-org.org`.
   - Copy the application's **AUD tag** and your team domain for step 5.
4. `cd worker && npx wrangler d1 create annotate`. Copy the id for step 5.
5. Create an API token for the Worker: **Account → Cloudflare Tunnel → Edit**
   and **Zone → DNS → Edit** on the zone.

### 5. The Worker

In `worker/wrangler.jsonc` under `env.production`:

- Uncomment `routes` and set the site hostname.
- Set the D1 `database_id`.
- Fill in every `REPLACE_…` value: Terraform outputs, account and zone ids,
  and the Access AUD and team domain.
- Set `SESSION_HOSTNAME` to the desktop pattern, with `{id}` in it.

Then:

```sh
make build
cd worker
npm run deploy                                   # D1 migrations, then the Worker
npx wrangler secret put AWS_ACCESS_KEY_ID --env production
npx wrangler secret put AWS_SECRET_ACCESS_KEY --env production
npx wrangler secret put CF_API_TOKEN --env production
openssl rand -base64 32 | npx wrangler secret put DCV_TOKEN_SECRET --env production
```

### 6. Continuous deployment

Once step 5 works by hand, add GitHub secrets `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`. Use the "Edit Cloudflare Workers" token template,
plus **Account → D1 → Edit**. Then set the repository variable `DEPLOY` to
`true`. From then on, every push to `main` that passes the tests deploys
the site and the Worker.

## Not yet tested against the real services

Everything above passes locally: the site in a browser, the Worker against
the pretend cloud, and the AWS and Cloudflare clients against canned
responses. Terraform and Packer also pass their validators, and napari runs
under a virtual display.

None of it has run against real AWS or Cloudflare, and the AMI has never
been built. The DCV download site wasn't reachable from where this was
written. On the first real build and session (Phase 0 in PLAN.md), check:

- **The DCV download:** the package names for Ubuntu 24.04 in `ami/provision.sh`.
- **Sign-in to the desktop:** DCV accepts `auth-token-verifier` over plain
  HTTP on localhost and logs in with `desktop/dcv-token-verifier.py`'s answer.
- **Idle detection:** `dcv list-connections --json annotate` prints a JSON
  array. If it doesn't, the watchdog assumes someone is connected, so idle
  desktops only stop through **End session** or by closing napari.
- **The desktop through the tunnel:** the DCV web client works through a
  Cloudflare Tunnel, including napari's keyboard shortcuts.
- **Instance size:** napari's speed and memory on a real region decide
  `instance_type`.
- **Permissions:** if **Start** fails with `UnauthorizedOperation`, check the
  launch-template conditions on the Worker's policy in `infra/main.tf`.
