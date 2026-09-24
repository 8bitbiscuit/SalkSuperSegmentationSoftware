variable "data_url" {
  description = "The folder in the existing bucket that holds the brain-region folders, e.g. s3://my-bucket/spida_dev/cellpose_3d_test/patches/"
  type        = string
  validation {
    condition     = can(regex("^s3://[a-z0-9][a-z0-9.-]+[a-z0-9](/[A-Za-z0-9._/-]*)?$", var.data_url))
    error_message = "data_url looks like s3://bucket/folder/"
  }
}

variable "cognito_user_pool_id" {
  description = "The existing Cognito user pool people sign in with, e.g. us-west-2_AbC123xyz. Its region is where everything is made."
  type        = string
  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]_[A-Za-z0-9]+$", var.cognito_user_pool_id))
    error_message = "cognito_user_pool_id looks like us-west-2_AbC123xyz"
  }
}

variable "site_url" {
  description = "Where the website is, e.g. https://annotate.your-name.workers.dev. Cognito only sends people back here after sign-in."
  type        = string
  validation {
    condition     = can(regex("^https://[^/]+/?$", var.site_url))
    error_message = "site_url is https://<host>, with no path"
  }
}

variable "subnet_id" {
  description = "An existing subnet the desktops start in, in the user pool's region. It must reach the internet: the subnet your lab's EC2 instances already use is a safe choice."
  type        = string
  validation {
    condition     = can(regex("^subnet-[0-9a-f]+$", var.subnet_id))
    error_message = "subnet_id looks like subnet-0123456789abcdef0"
  }
}

variable "cognito_managed_login" {
  description = "false if the pool is on Cognito's Lite plan (apply then fails with FeatureUnavailableInTierException), which only has the classic hosted sign-in page."
  type        = bool
  default     = true
}

variable "cognito_identity_providers" {
  description = "Where people sign in: COGNITO is the pool's own usernames and passwords. Add the name of an institutional (SAML/OIDC) provider the pool already has, if people use that."
  type        = list(string)
  default     = ["COGNITO"]
}

variable "instance_type" {
  description = "Desktop size. RAM must hold a full image plane, the painted masks and a save; set it from the Phase 0 measurements."
  type        = string
  default     = "r6i.4xlarge" # 16 vCPU, 128 GiB
}

variable "root_volume_gb" {
  type    = number
  default = 100
}

variable "github_repo" {
  description = "owner/name of this repository, for the AMI build's OIDC trust."
  type        = string
  default     = "8bitbiscuit/SalkSuperSegmentationSoftware"
}

variable "create_github_oidc_provider" {
  description = "false if the AWS account already has GitHub's OIDC provider (there can be only one)."
  type        = bool
  default     = true
}
