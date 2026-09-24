# AWS for the annotation desktops: a security group with no inbound access in
# an existing subnet, the desktop launch template, the website's sign-in app
# in the existing Cognito user pool, a role signed-in users act through, and
# narrow identities for the desktops and the AMI build. The bucket, the user
# pool and the network already exist and are only referred to: nothing here
# changes their settings. See README.md.

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
  region = local.region
  default_tags {
    tags = { Project = "annotate" }
  }
}

data "aws_caller_identity" "me" {}

locals {
  region = split("_", var.cognito_user_pool_id)[0] # everything lives where the user pool does
  data   = regex("^s3://([^/]+)/*(.*)$", var.data_url)
  prefix = local.data[1] == "" ? "" : "${trimsuffix(local.data[1], "/")}/" # <prefix><brain region>/<region>/<fov>/
  site   = trimsuffix(var.site_url, "/")

  account    = data.aws_caller_identity.me.account_id
  bucket_arn = data.aws_s3_bucket.data.arn
}

# The existing bucket and user pool. Looking them up fails the plan early on a wrong name.
data "aws_s3_bucket" "data" {
  bucket = local.data[0]
}

data "aws_cognito_user_pool" "pool" {
  user_pool_id = var.cognito_user_pool_id
}

# ---- network: an existing subnet; browsers arrive through Cloudflare Tunnels ----

data "aws_subnet" "desktops" {
  id = var.subnet_id
}

# The AMI build (ami/) looks the subnet up here.
resource "aws_ssm_parameter" "subnet" {
  name  = "/annotate/subnet"
  type  = "String"
  value = var.subnet_id
}

resource "aws_security_group" "desktop" {
  name        = "annotate-desktop"
  description = "No inbound: browsers reach the desktop through its Cloudflare Tunnel"
  vpc_id      = data.aws_subnet.desktops.vpc_id

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
    subnet_id             = var.subnet_id
    security_groups       = [aws_security_group.desktop.id]
    delete_on_termination = true # a public IP or not: the subnet's own setting decides
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

# ---- the desktop machine's own permissions: only DCV's licence check ---------
# Everything it does with the bucket, it does as the signed-in user (below).

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
    sid       = "DcvLicense"
    actions   = ["s3:GetObject"]
    resources = ["arn:aws:s3:::dcv-license.${local.region}/*"]
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

# ---- sign-in: the website's app in the existing user pool -------------------

resource "aws_cognito_user_pool_client" "site" {
  name                                 = "annotate-site"
  user_pool_id                         = var.cognito_user_pool_id
  generate_secret                      = true
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = var.cognito_identity_providers
  callback_urls                        = ["${local.site}/auth/callback"]
  logout_urls                          = ["${local.site}/"]
  explicit_auth_flows                  = ["ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors        = "ENABLED"
}

# The sign-in page lives on the pool's domain. Made only if the pool has none.
resource "aws_cognito_user_pool_domain" "site" {
  count                 = length(compact([data.aws_cognito_user_pool.pool.domain, data.aws_cognito_user_pool.pool.custom_domain])) == 0 ? 1 : 0
  domain                = "annotate-${local.account}"
  user_pool_id          = var.cognito_user_pool_id
  managed_login_version = var.cognito_managed_login ? 2 : 1
}

# Managed login shows no sign-in page for an app without a style; this is Cognito's default one.
resource "aws_cognito_managed_login_branding" "site" {
  count                       = var.cognito_managed_login ? 1 : 0
  user_pool_id                = var.cognito_user_pool_id
  client_id                   = aws_cognito_user_pool_client.site.id
  use_cognito_provided_values = true
}

# ---- signed-in users: start desktops and use the bucket, in their own name ----
#
# The website and each desktop trade the user's Cognito ID token for this
# role (AssumeRoleWithWebIdentity), with the user's email as the session name.
# CloudTrail records every call as assumed-role/annotate-user/<email>.

resource "aws_iam_openid_connect_provider" "cognito" {
  url            = "https://cognito-idp.${local.region}.amazonaws.com/${var.cognito_user_pool_id}"
  client_id_list = [aws_cognito_user_pool_client.site.id]
}

data "aws_iam_policy_document" "user_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.cognito.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "cognito-idp.${local.region}.amazonaws.com/${var.cognito_user_pool_id}:aud"
      values   = [aws_cognito_user_pool_client.site.id]
    }
  }
}

resource "aws_iam_role" "user" {
  name                 = "annotate-user"
  assume_role_policy   = data.aws_iam_policy_document.user_assume.json
  max_session_duration = 43200
}

data "aws_iam_policy_document" "user" {
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
      "arn:aws:ec2:${local.region}:${local.account}:instance/*",
      "arn:aws:ec2:${local.region}:${local.account}:volume/*",
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
    resources = ["arn:aws:ec2:${local.region}:${local.account}:instance/*"]
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
    sid       = "ListTheData"
    actions   = ["s3:ListBucket"]
    resources = [local.bucket_arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["${local.prefix}*"]
    }
  }
  statement {
    sid       = "ReadImagesAndMasks"
    actions   = ["s3:GetObject"]
    resources = ["${local.bucket_arn}/${local.prefix}*"]
  }
  statement {
    sid       = "WriteMasks"
    actions   = ["s3:PutObject", "s3:AbortMultipartUpload"]
    resources = ["${local.bucket_arn}/${local.prefix}*/masks/*"]
  }
}

resource "aws_iam_role_policy" "user" {
  role   = aws_iam_role.user.id
  policy = data.aws_iam_policy_document.user.json
}

# ---- the AMI build box: Packer reaches it through Session Manager ------------
# The box calls out to AWS, so it needs no public IP and no open port: it
# works in a private subnet.

resource "aws_iam_role" "ami_builder" {
  name               = "annotate-ami-builder"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "ami_builder" {
  role       = aws_iam_role.ami_builder.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "ami_builder" {
  name = "annotate-ami-builder" # ami/annotate.pkr.hcl uses it by this name
  role = aws_iam_role.ami_builder.name
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
  statement {
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.subnet.arn]
  }
  statement {
    sid       = "StartTheBuildBoxWithItsProfile"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.ami_builder.arn]
  }
  statement {
    sid     = "ReachTheBuildBox"
    actions = ["ssm:StartSession"]
    resources = [
      "arn:aws:ec2:${local.region}:${local.account}:instance/*",
      "arn:aws:ssm:${local.region}::document/AWS-StartPortForwardingSession",
    ]
  }
  statement {
    actions   = ["ssm:TerminateSession", "ssm:ResumeSession"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "ami_build" {
  role   = aws_iam_role.ami_build.id
  policy = data.aws_iam_policy_document.ami_build.json
}
