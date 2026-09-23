variable "region" {
  type    = string
  default = "us-west-2"
}

variable "bucket_name" {
  description = "S3 bucket for region images and masks. Globally unique; no dots."
  type        = string
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
