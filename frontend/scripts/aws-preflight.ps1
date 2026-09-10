# Verifies the AWS deploy identity has every permission the Lambda migration
# needs. Read-only: creates nothing. Prints allowed/denied per service only,
# never credential values.

$envFile = Join-Path $PSScriptRoot "..\..\.env"
foreach ($name in @("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION")) {
  $match = Select-String -Path $envFile -Pattern ("^\s*" + $name + "\s*=\s*(.+)$") -ErrorAction SilentlyContinue
  if ($match) { Set-Item -Path ("env:" + $name) -Value $match.Matches.Groups[1].Value.Trim().Trim('"').Trim("'") }
}
if (-not $env:AWS_REGION) { $env:AWS_REGION = "ap-southeast-2" }
$env:AWS_DEFAULT_REGION = $env:AWS_REGION

function Test-Permission {
  param([string]$Label, [string]$Command)
  $output = (Invoke-Expression ($Command + " 2>&1") | Out-String)
  $denied = $output -match "AccessDenied|not authorized|UnauthorizedOperation|explicit deny"
  $status = if ($denied) { "DENIED " } else { "allowed" }
  return ("  {0}  {1}" -f $status, $Label)
}

$results = @()
$results += "AWS preflight  region=$env:AWS_REGION"
$results += ""
$results += Test-Permission "sts:GetCallerIdentity" "aws sts get-caller-identity"
$results += Test-Permission "lambda:ListFunctions" "aws lambda list-functions --max-items 1"
$results += Test-Permission "sqs:ListQueues" "aws sqs list-queues"
$results += Test-Permission "s3:ListAllMyBuckets" "aws s3api list-buckets"
$results += Test-Permission "secretsmanager:ListSecrets" "aws secretsmanager list-secrets --max-results 1"
$results += Test-Permission "cloudformation:ListStacks" "aws cloudformation list-stacks"
$results += Test-Permission "logs:DescribeLogGroups" "aws logs describe-log-groups --limit 1"
$results += Test-Permission "cloudwatch:DescribeAlarms" "aws cloudwatch describe-alarms --max-records 1"
# Scoped probes: these must succeed for provisioning, and a NoSuchEntity or
# NotFound reply still proves the action is permitted.
$results += Test-Permission "iam:GetRole (parcel-atlas-*)" "aws iam get-role --role-name parcel-atlas-preflight-probe"
$results += Test-Permission "sqs:GetQueueUrl (parcel-atlas-*)" "aws sqs get-queue-url --queue-name parcel-atlas-preflight-probe"

$results | ForEach-Object { Write-Output $_ }

$denied = ($results | Where-Object { $_ -match "DENIED" })
Write-Output ""
if ($denied.Count -gt 0) {
  Write-Output "RESULT: $($denied.Count) permission(s) still denied. Provisioning would fail."
  exit 1
}
Write-Output "RESULT: all probed permissions are available."
exit 0
