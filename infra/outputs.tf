output "cloudflare_settings" {
  description = "Add each one in Cloudflare: Workers & Pages -> annotate -> Settings -> Variables and Secrets"
  value = {
    DATA_URL             = var.data_url
    COGNITO_USER_POOL_ID = var.cognito_user_pool_id
    COGNITO_CLIENT_ID    = aws_cognito_user_pool_client.site.id
    AWS_ROLE_ARN         = aws_iam_role.user.arn
  }
}

output "cognito_client_secret" {
  description = "The last setting, COGNITO_CLIENT_SECRET (add it as a Secret): terraform output -raw cognito_client_secret"
  value       = aws_cognito_user_pool_client.site.client_secret
  sensitive   = true
}

output "ami_build_role_arn" {
  description = "GitHub repository variable AWS_AMI_BUILD_ROLE_ARN"
  value       = aws_iam_role.ami_build.arn
}
