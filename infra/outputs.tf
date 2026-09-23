output "bucket" {
  description = "worker/wrangler.jsonc BUCKET"
  value       = aws_s3_bucket.data.bucket
}

output "launch_template_id" {
  description = "worker/wrangler.jsonc LAUNCH_TEMPLATE_ID"
  value       = aws_launch_template.desktop.id
}

output "worker_user" {
  description = "Make its access key with: aws iam create-access-key --user-name <this>"
  value       = aws_iam_user.worker.name
}

output "lab_sync_user" {
  value = aws_iam_user.lab_sync.name
}

output "ami_build_role_arn" {
  description = "GitHub repository variable AWS_AMI_BUILD_ROLE_ARN"
  value       = aws_iam_role.ami_build.arn
}
