# The desktop image every session boots from. Build it with
#   packer init ami && packer build ami
# (or the "Build desktop AMI" workflow), then point new sessions at it:
#   aws ssm put-parameter --name /annotate/ami --data-type aws:ec2:image \
#     --type String --overwrite --value <ami id from ami/manifest.json>
packer {
  required_plugins {
    amazon = {
      source  = "github.com/hashicorp/amazon"
      version = ">= 1.3.0"
    }
  }
}

variable "region" {
  type    = string
  default = "us-west-2"
}

source "amazon-ebs" "desktop" {
  region        = var.region
  instance_type = "m6i.large"
  ami_name      = "annotate-desktop-${formatdate("YYYYMMDD-hhmm", timestamp())}"

  source_ami_filter {
    filters = {
      name                = "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"
      root-device-type    = "ebs"
      virtualization-type = "hvm"
    }
    owners      = ["099720109477"] # Canonical
    most_recent = true
  }

  # The public subnet infra/ creates; the build box needs the internet.
  subnet_filter {
    filters = { "tag:Name" = "annotate-public" }
  }
  associate_public_ip_address = true
  ssh_username                = "ubuntu"

  launch_block_device_mappings {
    device_name           = "/dev/sda1"
    volume_size           = 30
    volume_type           = "gp3"
    delete_on_termination = true
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  tags = {
    App  = "annotate"
    Name = "annotate desktop"
  }
}

build {
  sources = ["source.amazon-ebs.desktop"]

  provisioner "file" {
    source      = "${path.root}/../desktop/"
    destination = "/tmp/desktop"
  }

  provisioner "shell" {
    script          = "${path.root}/provision.sh"
    execute_command = "sudo -E bash '{{ .Path }}'"
  }

  post-processor "manifest" {
    output     = "${path.root}/manifest.json"
    strip_path = true
  }
}
