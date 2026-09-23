# AWS for the annotation desktops: the data bucket, a small network with no
# inbound access, the desktop launch template, and three narrow identities
# (the Worker, the lab server's sync, the AMI build). See README.md.

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = "annotate" }
  }
}

data "aws_caller_identity" "me" {}

locals {
  account    = data.aws_caller_identity.me.account_id
  bucket_arn = aws_s3_bucket.data.arn
}

# ---- data: regions/<region>/images/ and regions/<region>/masks/ -------------

resource "aws_s3_bucket" "data" {
  bucket = var.bucket_name
}

resource "aws_s3_bucket_public_access_block" "data" {
  bucket                  = aws_s3_bucket.data.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Every autosave overwrites the session's masks file; versions keep the
# earlier ones, so a bad save can be rolled back.
resource "aws_s3_bucket_versioning" "data" {
  bucket = aws_s3_bucket.data.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "data" {
  bucket     = aws_s3_bucket.data.id
  depends_on = [aws_s3_bucket_versioning.data]

  rule {
    id     = "expire-replaced-versions"
    status = "Enabled"
    filter {
      prefix = "regions/"
    }
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# ---- network: outbound only; browsers arrive through Cloudflare Tunnels ----

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "main" {
  cidr_block           = "10.42.0.0/16"
  enable_dns_hostnames = true
  tags                 = { Name = "annotate" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.42.0.0/20"
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true
  tags                    = { Name = "annotate-public" } # ami/ finds it by this name
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "desktop" {
  name        = "annotate-desktop"
  description = "No inbound: browsers reach the desktop through its Cloudflare Tunnel"
  vpc_id      = aws_vpc.main.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ---- the desktop -----------------------------------------------------------

# Which AMI new sessions boot. Starts as stock Ubuntu so the launch template
# can be created; the "Build desktop AMI" workflow points it at each new build.
data "aws_ssm_parameter" "ubuntu" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

resource "aws_ssm_parameter" "ami" {
  name      = "/annotate/ami"
  type      = "String"
  data_type = "aws:ec2:image"
  value     = data.aws_ssm_parameter.ubuntu.value
  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_launch_template" "desktop" {
  name                                 = "annotate-desktop"
  image_id                             = "resolve:ssm:${aws_ssm_parameter.ami.name}"
  instance_type                        = var.instance_type
  instance_initiated_shutdown_behavior = "terminate" # the desktop powers off when done
  update_default_version               = true

  iam_instance_profile {
    arn = aws_iam_instance_profile.desktop.arn
  }

  network_interfaces {
    subnet_id                   = aws_subnet.public.id
    security_groups             = [aws_security_group.desktop.id]
    associate_public_ip_address = true
    delete_on_termination       = true
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "enabled" # the watchdog reads the Stop tag
  }

  block_device_mappings {
    device_name = "/dev/sda1"
    ebs {
      volume_size           = var.root_volume_gb
      volume_type           = "gp3"
      delete_on_termination = true
    }
  }

  tag_specifications {
    resource_type = "volume"
    tags          = { App = "annotate" }
  }
}

# ---- the desktop's own permissions ------------------------------------------

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "desktop" {
  name               = "annotate-desktop"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

data "aws_iam_policy_document" "desktop" {
  statement {
    sid       = "ListRegions"
    actions   = ["s3:ListBucket"]
    resources = [local.bucket_arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["regions/*"]
    }
  }
  statement {
    sid       = "ReadImagesAndMasks"
    actions   = ["s3:GetObject"]
    resources = ["${local.bucket_arn}/regions/*"]
  }
  statement {
    sid       = "WriteMasks"
    actions   = ["s3:PutObject", "s3:AbortMultipartUpload"]
    resources = ["${local.bucket_arn}/regions/*/masks/*"]
  }
  statement {
    sid       = "DcvLicense"
    actions   = ["s3:GetObject"]
    resources = ["arn:aws:s3:::dcv-license.${var.region}/*"]
  }
}

resource "aws_iam_role_policy" "desktop" {
  role   = aws_iam_role.desktop.id
  policy = data.aws_iam_policy_document.desktop.json
}

resource "aws_iam_instance_profile" "desktop" {
  name = "annotate-desktop"
  role = aws_iam_role.desktop.name
}

# ---- the Cloudflare Worker: launch, watch, stop, list masks -----------------

resource "aws_iam_user" "worker" {
  name = "annotate-worker"
}

data "aws_iam_policy_document" "worker" {
  statement {
    sid       = "LaunchOnlyFromTheTemplate"
    actions   = ["ec2:RunInstances"]
    resources = ["*"]
    condition {
      test     = "ArnLike"
      variable = "ec2:LaunchTemplate"
      values   = [aws_launch_template.desktop.arn]
    }
    condition {
      test     = "Bool"
      variable = "ec2:IsLaunchTemplateResource"
      values   = ["true"]
    }
  }
  statement {
    sid       = "ResolveTheAmiParameter"
    actions   = ["ssm:GetParameters"]
    resources = [aws_ssm_parameter.ami.arn]
  }
  statement {
    sid       = "PassTheDesktopRole"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.desktop.arn]
  }
  statement {
    sid     = "TagAtLaunch"
    actions = ["ec2:CreateTags"]
    resources = [
      "arn:aws:ec2:${var.region}:${local.account}:instance/*",
      "arn:aws:ec2:${var.region}:${local.account}:volume/*",
    ]
    condition {
      test     = "StringEquals"
      variable = "ec2:CreateAction"
      values   = ["RunInstances"]
    }
  }
  statement {
    sid       = "StopAndTerminateDesktops"
    actions   = ["ec2:CreateTags", "ec2:TerminateInstances"]
    resources = ["arn:aws:ec2:${var.region}:${local.account}:instance/*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/App"
      values   = ["annotate"]
    }
  }
  statement {
    sid       = "SeeDesktops"
    actions   = ["ec2:DescribeInstances"]
    resources = ["*"]
  }
  statement {
    sid       = "ListMasks"
    actions   = ["s3:ListBucket"]
    resources = [local.bucket_arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["regions/*/masks/*"]
    }
  }
}

resource "aws_iam_user_policy" "worker" {
  user   = aws_iam_user.worker.name
  policy = data.aws_iam_policy_document.worker.json
}

# ---- the lab server: upload images, pull masks -------------------------------

resource "aws_iam_user" "lab_sync" {
  name = "annotate-lab-sync"
}

data "aws_iam_policy_document" "lab_sync" {
  statement {
    actions   = ["s3:ListBucket"]
    resources = [local.bucket_arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["regions/*"]
    }
  }
  statement {
    actions   = ["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload"]
    resources = ["${local.bucket_arn}/regions/*"]
  }
}

resource "aws_iam_user_policy" "lab_sync" {
  user   = aws_iam_user.lab_sync.name
  policy = data.aws_iam_policy_document.lab_sync.json
}

# ---- GitHub Actions: build the AMI (no stored AWS keys) ----------------------

resource "aws_iam_openid_connect_provider" "github" {
  count          = var.create_github_oidc_provider ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

locals {
  github_oidc_arn = (var.create_github_oidc_provider
    ? aws_iam_openid_connect_provider.github[0].arn
  : "arn:aws:iam::${local.account}:oidc-provider/token.actions.githubusercontent.com")
}

data "aws_iam_policy_document" "github_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:ref:refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "ami_build" {
  name               = "annotate-ami-build"
  assume_role_policy = data.aws_iam_policy_document.github_assume.json
}

# What Packer's amazon-ebs builder needs, plus pointing sessions at the result.
data "aws_iam_policy_document" "ami_build" {
  statement {
    actions = [
      "ec2:AttachVolume", "ec2:AuthorizeSecurityGroupIngress", "ec2:CopyImage", "ec2:CreateImage",
      "ec2:CreateKeyPair", "ec2:CreateSecurityGroup", "ec2:CreateSnapshot", "ec2:CreateTags",
      "ec2:CreateVolume", "ec2:DeleteKeyPair", "ec2:DeleteSecurityGroup", "ec2:DeleteSnapshot",
      "ec2:DeleteVolume", "ec2:DeregisterImage", "ec2:DescribeImageAttribute", "ec2:DescribeImages",
      "ec2:DescribeInstances", "ec2:DescribeInstanceStatus", "ec2:DescribeRegions",
      "ec2:DescribeSecurityGroups", "ec2:DescribeSnapshots", "ec2:DescribeSubnets", "ec2:DescribeTags",
      "ec2:DescribeVolumes", "ec2:DescribeVpcs", "ec2:DetachVolume", "ec2:GetPasswordData",
      "ec2:ModifyImageAttribute", "ec2:ModifyInstanceAttribute", "ec2:ModifySnapshotAttribute",
      "ec2:RegisterImage", "ec2:RunInstances", "ec2:StopInstances", "ec2:TerminateInstances",
    ]
    resources = ["*"]
  }
  statement {
    actions   = ["ssm:PutParameter"]
    resources = [aws_ssm_parameter.ami.arn]
  }
}

resource "aws_iam_role_policy" "ami_build" {
  role   = aws_iam_role.ami_build.id
  policy = data.aws_iam_policy_document.ami_build.json
}
