variable "data_url" {
  description = "The existing bucket, e.g. s3://my-bucket/"
  type        = string
  validation {
    condition     = can(regex("^s3://[a-z0-9][a-z0-9.-]+[a-z0-9]/?$", var.data_url))
    error_message = "data_url is now the bucket itself, like s3://salk-workstation-data-dev-020125249408/ (it used to end in spida_dev/cellpose_3d_test/patches/)"
  }
}

variable "data_folders" {
  description = "The folders in the bucket that annotators read images from and save masks to: the roots of the site's data choices (SOURCES in worker/src/sources.ts)."
  type        = list(string)
  default     = ["spida_dev/cellpose_3d_test/patches", "spatial_data"]
  validation {
    condition     = length(var.data_folders) > 0 && alltrue([for f in var.data_folders : can(regex("^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*$", f))])
    error_message = "data_folders are folder paths in the bucket, like spatial_data, with no slash at either end"
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
