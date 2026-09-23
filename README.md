# Segmentation desktops

Annotators sign in to a website, pick a region, and get their own cloud
desktop with napari open on it. They paint masks in the browser; masks save
to S3 every few minutes and when the session ends. The desktop shuts itself
down when they're done or walk away.

- **`site/`** is the Jekyll website: the session panel and the annotator guide.
- **`worker/`** is a Cloudflare Worker that serves the site and runs sessions.
  It launches EC2 desktops and makes a Cloudflare Tunnel for each one. Its
  config (`wrangler.jsonc`, `package.json`) sits at the top of the project,
  so Cloudflare can build and run it straight from the repository.
- **`desktop/`** is what runs on each desktop: `open_project.py` (the Anvil
  script, which now also saves on exit), plus the boot, sync and shutdown
  scripts.
- **`ami/`** (Packer) and **`infra/`** (Terraform, us-west-2) build the AWS side.
  Region images and masks live in the existing bucket
  `salk-workstation-data-dev-020125249408`, under `spida_dev/cellpose_3d_test/patches/`.
- People sign in with the existing Cognito user pool. After that, everything
  that touches AWS happens **as them**: the website starts and stops their
  desktop, and the desktop reads images and saves masks, with AWS
  credentials in their own name. CloudTrail shows each call as
  `assumed-role/annotate-user/<their email>`.

[PLAN.md](PLAN.md) explains the design and the reasons behind it.

## Run it locally

You need Ruby 3.2+, Node 22.18+ and `make`.

macOS comes with Ruby 2.6, which is too old. Install a current one with
[Homebrew](https://brew.sh) and put it first on your `PATH`:

```sh
brew install ruby
echo 'export PATH="$(brew --prefix ruby)/bin:$PATH"' >> ~/.zshrc
exec zsh
ruby -v   # 3.2 or newer
```

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
  D1 database under `.wrangler/` and survives restarts.
- To act as someone else, put `DEV_EMAIL=someone@example.org` in
  `.dev.vars` and restart.
- To run the 10-minute cron by hand:
  `curl "http://localhost:8787/__scheduled?cron=*/10+*+*+*+*"`
- The pretend bucket has a few fields of view (`CBDN/region_UWA-7648/fov_07`
  and others) in `worker/src/mock.ts`.

The desktop tests run the real napari script and the watchdog. They need
napari installed (`pip install -r desktop/requirements.txt pytest`), then
`make test-desktop`. On a Linux machine with no display, use
`xvfb-run -a make test-desktop`.

## Deploy

Four steps. After step 1 the site is online and says which settings it still
needs; after step 3 people can sign in and browse the bucket; step 4 adds the
desktops, and needs the domain.

### 1. Put the site on Cloudflare

1. Make a free Cloudflare account at dash.cloudflare.com if you don't have one.
2. Put this project on GitHub (or GitLab).
3. In the Cloudflare dashboard: **Workers & Pages → Create → Import a
   repository**. Connect GitHub and pick the repository.
4. On the settings screen:
   - **Project name:** `annotate`. It must match `name` in `wrangler.jsonc`.
   - **Build command:** `npm run build`. This builds the Jekyll site.
   - **Deploy command:** leave it as `npx wrangler deploy`.
5. **Deploy.** Cloudflare builds the site, creates its database, and gives it
   an address like `https://annotate.<your-subdomain>.workers.dev`.

Open the address. It shows an **Almost there** page listing the settings it
still needs. That's expected: step 3 adds them. From now on, every push to
the main branch rebuilds and republishes the site.

Without GitHub, you can publish from your own computer instead, after
`make install`: `npx wrangler login`, then `npm run deploy`.

### 2. AWS: one Terraform run

This connects the site to AWS. It uses your existing bucket and user pool,
and changes neither.

Install the tools and sign in to AWS:

```sh
brew install awscli
brew tap hashicorp/tap
brew install hashicorp/tap/terraform hashicorp/tap/packer
aws configure sso               # your account uses the organization sign-in page
export AWS_PROFILE=<the profile name you chose>
aws sts get-caller-identity     # should show account 020125249408
```

Then:

```sh
cd infra
cp terraform.tfvars.example terraform.tfvars
```

Fill in three values in `terraform.tfvars`:

- `data_url`: the bucket folder that holds the brain-region folders.
- `cognito_user_pool_id`: from the Cognito console, e.g. `us-west-2_AbC123xyz`.
  Everything is created in the pool's region.
- `site_url`: the address from step 1.

```sh
terraform init
terraform apply                                  # lists what it will create; type "yes"
terraform output cloudflare_settings             # four settings for step 3
terraform output -raw cognito_client_secret      # the fifth, a secret
```

What it creates:

- **An app for the website in your user pool.** It has a client secret and is
  allowed to send people back to `site_url` after sign-in. If the pool has no
  sign-in domain yet, Terraform adds one: `annotate-<account number>`.
- **The `annotate-user` role**, which signed-in people act through. It can
  start desktops from the launch template, end them, list the data folder,
  read images and write `masks/` folders. Nothing else.
- **The desktop launch template**, and a small network with no inbound access.
- **A role for GitHub** to build the desktop image (step 4).

Keep `infra/terraform.tfstate`. It's Terraform's record of what it created,
and it needs that record to change or remove anything later.

If `terraform apply` stops with:

- **`AccessDenied` on an `iam:` or `cognito-idp:` action:** your AWS role
  can't create roles or user-pool apps. An account administrator needs to run
  it, or give you a role that can.
- **`FeatureUnavailableInTierException`:** the user pool is on Cognito's Lite
  plan, which only has the classic sign-in page. Add
  `cognito_managed_login = false` to `terraform.tfvars` and apply again.
- **If people sign in through the institution** rather than with a pool
  password, add the pool's name for that provider to
  `cognito_identity_providers` in `terraform.tfvars`.

Things to check on the bucket (it's shared, so Terraform never changes it):

- **Properties → Default encryption.** If it uses SSE-KMS with a customer
  managed key, the `annotate-user` role also needs permission to use that
  key. Send me its ARN and I'll add it.
- **Permissions → Bucket policy.** If the policy limits who can read or
  write, the owner must allow the `annotate-user` role.
- **Properties → Bucket Versioning.** If it's on, an overwritten masks file
  can be recovered. If it's off, masks are still saved every few minutes,
  but a bad save can't be undone.

### 3. Give the site its settings

In the Cloudflare dashboard: **Workers & Pages → annotate → Settings →
Variables and Secrets → Add**.

| Name | Type | Value |
| --- | --- | --- |
| `DATA_URL` | Text | from `terraform output cloudflare_settings` |
| `COGNITO_USER_POOL_ID` | Text | 〃 |
| `COGNITO_CLIENT_ID` | Text | 〃 |
| `AWS_ROLE_ARN` | Text | 〃 |
| `COGNITO_CLIENT_SECRET` | Secret | from `terraform output -raw cognito_client_secret` |

**Deploy** to save them. Then open the site. It sends you to the Cognito
sign-in page, and after you sign in it lists the brain regions. That means the
whole chain works: Cognito, then AWS in your name, then the bucket.
**Start session** replies that desktops aren't set up yet until step 4.

Optional settings, with their defaults:

- `CHANNEL` (`DAPI_decon`): which images open. A folder counts as a field of
  view when it holds `<CHANNEL>_z<number>.tif` files.
- `IDLE_MINUTES` (`30`): a desktop with nobody connected this long powers off.

If something goes wrong, **Workers & Pages → annotate → Logs** (or
`npx wrangler tail`) shows the site's errors while you click.

### 4. Desktops (needs the domain)

1. **Build the desktop image.** From the project folder (or with the **Build
   desktop AMI** workflow on GitHub):
   ```sh
   packer init ami
   packer build ami    # 20–30 minutes; prints an image id (ami-...) at the end
   aws ssm put-parameter --name /annotate/ami --type String \
     --data-type aws:ec2:image --overwrite --value ami-...
   ```
2. **Put the domain on Cloudflare.** Each desktop gets its own address under
   it. Dashboard → **Add a domain** (or a subdomain your IT delegates).
3. **Make an API token** so the site can make a tunnel and an address for
   each desktop: **My Profile → API Tokens → Create Token → Custom token**,
   with:
   - **Account → Cloudflare Tunnel → Edit**
   - **Zone → DNS → Edit** and **Zone → Zone → Read**, for that domain
4. **Add two more settings** (step 3's page):
   - `CF_API_TOKEN` (Secret): the token.
   - `DESKTOP_HOSTNAME` (Text): the desktop addresses, with `{id}` where
     each session's id goes, e.g. `annotate-{id}.example.org`. Keep it one
     level below the domain, so Cloudflare's free certificate covers it.
5. Sign in and start a session.

To move the site itself onto the domain: **Workers & Pages → annotate →
Settings → Domains & Routes → Add → Custom domain**. Then change `site_url`
in `infra/terraform.tfvars` and run `terraform apply` again, so Cognito sends
people back to the new address.

### How sign-in and AWS access fit together

1. Someone opens the site. The site sends them to the user pool's sign-in
   page, and Cognito sends them back with a token that says who they are.
2. The site trades that token with AWS for short-lived credentials for the
   `annotate-user` role, named after the person's email
   (`AssumeRoleWithWebIdentity`). No stored AWS keys are involved. It uses
   those credentials to list folders and masks, and to start, stop and end
   that person's desktop.
3. The desktop does the same: every 15 minutes it collects a fresh token for
   its user from the site. mount-s3 and the AWS CLI then read the images and
   save masks in that person's name.
4. Every 10 minutes the site checks each running desktop, using its owner's
   sign-in. If that sign-in can't be used any more, the desktop still powers
   itself off once nobody has been connected for `IDLE_MINUTES`.

### The data

The picker reads the folders live from `DATA_URL`, one level at a time, until
a folder with images opens:

```
<brain region>/<region>/<field of view>/DAPI_decon_z0.tif, DAPI_decon_z1.tif, ...
<brain region>/<region>/<field of view>/masks/     (created by the first save)
```

Saved masks go to the field of view's `masks/` folder, named
`<user>_<YYYYmmddTHHMMSS>_masks.tif.gz`. Only files named that way appear in
the resume list. Every user needs an email address in the pool; their masks
are named after the part before the @.

## Not yet tested against the real services

Everything above passes locally: the site in a browser, the Worker against
the pretend cloud, and the AWS and Cloudflare clients against canned
responses. Terraform and Packer also pass their validators, and napari runs
under a virtual display.

None of it has run against real AWS or Cloudflare, and the AMI has never
been built. The DCV download site wasn't reachable from where this was
written. On the first real build and session (Phase 0 in PLAN.md), check:

- **Cognito and AWS:** that AWS accepts the user pool's ID tokens for
  `annotate-user` (`AssumeRoleWithWebIdentity`, audience = the app
  client ID). If it doesn't, the site says "AWS would not sign in …" with
  AWS's reason.
- **mount-s3 as the user:** that mount-s3 picks up the web-identity settings
  (`AWS_ROLE_ARN`, `AWS_WEB_IDENTITY_TOKEN_FILE`) like the AWS CLI does.
- **The DCV download:** the package names for Ubuntu 24.04 in `ami/provision.sh`.
- **Sign-in to the desktop:** DCV accepts `auth-token-verifier` over plain
  HTTP on localhost and logs in with `desktop/dcv-token-verifier.py`'s answer.
- **The Cloudflare build:** that Cloudflare's build image installs the
  Jekyll gems (`npm run build`).
- **Idle detection:** `dcv list-connections --json annotate` prints a JSON
  array. If it doesn't, the watchdog assumes someone is connected, so idle
  desktops only stop through **End session** or by closing napari.
- **The desktop through the tunnel:** the DCV web client works through a
  Cloudflare Tunnel, including napari's keyboard shortcuts.
- **Instance size:** napari's speed and memory on a real region decide
  `instance_type`.
- **Permissions:** if **Start** fails with `UnauthorizedOperation`, check the
  launch-template conditions on the `annotate-user` policy in `infra/main.tf`.
