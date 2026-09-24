#!/bin/bash
# Turn stock Ubuntu 24.04 into the annotation desktop image. Packer runs this
# as root after copying desktop/ to /tmp/desktop.
#
# CPU only: napari renders with Mesa's software OpenGL. If the Phase 0
# measurements call for a GPU instance, this also needs the NVIDIA GRID
# driver and DCV's nice-dcv-gl package.
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive
cd /tmp

# A fresh instance is still setting itself up, and its automatic updates hold
# the package lock for a while: wait for both instead of failing. Keep the
# current version of any config file an upgrade would replace.
cloud-init status --wait || true   # non-zero also means "finished with warnings"
apt_get() {
  apt-get -o DPkg::Lock::Timeout=900 \
    -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "$@"
}

apt_get update
apt_get -y upgrade
apt_get install -y --no-install-recommends \
  ca-certificates curl unzip jq iptables python3 python3-venv \
  openbox x11-utils fonts-dejavu-core \
  xserver-common x11-xkb-utils xkb-data \
  libgl1 libglx-mesa0 libgl1-mesa-dri libegl1 libdbus-1-3 libfontconfig1 \
  libxkbcommon-x11-0 libxcb-cursor0 libxcb-icccm4 libxcb-image0 libxcb-keysyms1 \
  libxcb-randr0 libxcb-render-util0 libxcb-shape0 libxcb-xfixes0 libxcb-xinerama0

# Amazon DCV: server, browser client, and the X server for virtual sessions.
# Free on EC2; it licenses itself from an S3 bucket the instance role can read.
curl -fsSL https://d1uj6qtbmh3dt5.cloudfront.net/nice-dcv-ubuntu2404-x86_64.tgz | tar xz
apt_get install -y ./nice-dcv-*-ubuntu2404-x86_64/nice-dcv-server_*.deb \
                   ./nice-dcv-*-ubuntu2404-x86_64/nice-dcv-web-viewer_*.deb \
                   ./nice-dcv-*-ubuntu2404-x86_64/nice-xdcv_*.deb

# Mountpoint for S3 (the region's images), cloudflared (the tunnel), AWS CLI
# (resume downloads and masks sync).
curl -fsSLo mount-s3.deb https://s3.amazonaws.com/mountpoint-s3-release/latest/x86_64/mount-s3.deb
curl -fsSLo cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
apt_get install -y ./mount-s3.deb ./cloudflared.deb
echo user_allow_other >> /etc/fuse.conf   # mount-s3 --allow-other
curl -fsSLo awscliv2.zip https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip
unzip -q awscliv2.zip
./aws/install

# The desktop user. No password: the website's token is the only way in.
useradd --create-home --uid 2000 --shell /bin/bash annotate

# napari, and everything the session runs.
install -d /opt/annotate /etc/annotate
python3 -m venv /opt/annotate/venv
/opt/annotate/venv/bin/pip install --no-cache-dir -r /tmp/desktop/requirements.txt
/opt/annotate/venv/bin/python -c "import napari, dask, tifffile, magicgui"   # also compiles, for a faster first start
install -m 0755 -t /opt/annotate /tmp/desktop/*.sh /tmp/desktop/dcv-token-verifier.py
install -m 0644 -t /opt/annotate /tmp/desktop/open_project.py
install -m 0644 /tmp/desktop/dcv.conf /etc/dcv/dcv.conf
install -m 0644 -t /etc/systemd/system /tmp/desktop/systemd/*

systemctl daemon-reload
systemctl enable dcvserver.service annotate-session.service annotate-watchdog.timer

# Leave nothing of the build box behind.
rm -rf /tmp/desktop /tmp/nice-dcv-* /tmp/aws /tmp/awscliv2.zip /tmp/*.deb
apt_get clean
cloud-init clean --logs
