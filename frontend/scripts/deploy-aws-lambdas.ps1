# Deploys the built Lambda bundles and their environment configuration.
#
# Zips each bundle and calls update-function-code, then sets the non-secret
# environment variables. Secrets stay in Secrets Manager; only the secret ARN is
# passed as configuration.

# The AWS CLI writes progress to stderr even on success. Under
# $ErrorActionPreference = "Stop" PowerShell escalates that to a terminating
# error and the deploy aborts having changed nothing, so failures are detected
# from exit codes instead.
$ErrorActionPreference = "Continue"

$config = @{}
foreach ($line in Get-Content "D:\Realstate\.env") {
  if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
    $config[$Matches[1]] = $Matches[2].Trim().Trim('"').Trim("'")
  }
}
$env:AWS_ACCESS_KEY_ID = $config["AWS_ACCESS_KEY_ID"]
$env:AWS_SECRET_ACCESS_KEY = $config["AWS_SECRET_ACCESS_KEY"]
$env:AWS_DEFAULT_REGION = if ($config["AWS_REGION"]) { $config["AWS_REGION"] } else { "ap-southeast-2" }

$buildRoot = "D:\Realstate\.aws-build"
$stack = "parcel-atlas-pipeline"

# Resolve stack outputs so queue URLs and the bucket are not hardcoded.
$outputsRaw = aws cloudformation describe-stacks --stack-name $stack --query "Stacks[0].Outputs" --output json 2>$null | Out-String
if ($LASTEXITCODE -ne 0) { Write-Output "FAILED: could not read stack outputs."; exit 1 }
$outputs = @{}
foreach ($item in ($outputsRaw | ConvertFrom-Json)) { $outputs[$item.OutputKey] = $item.OutputValue }

$secretArn = $outputs["PipelineSecretArn"]
$bucket = $outputs["ArtifactBucketName"]
$reportQueue = $outputs["ReportQueueUrl"]
$deliveryQueue = $outputs["DeliveryQueueUrl"]

if (-not $secretArn -or -not $bucket) { Write-Output "FAILED: stack outputs are incomplete."; exit 1 }

$functions = @(
  @{ name = "parcel-atlas-dispatch";      dir = "dispatch" },
  @{ name = "parcel-atlas-report-worker"; dir = "report" },
  @{ name = "parcel-atlas-delivery";      dir = "delivery" }
)

foreach ($fn in $functions) {
  $source = Join-Path $buildRoot $fn.dir
  $zip = Join-Path $buildRoot ($fn.dir + ".zip")
  if (-not (Test-Path (Join-Path $source "index.js"))) {
    Write-Output ("FAILED: no bundle for " + $fn.name); exit 1
  }

  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  Compress-Archive -Path (Join-Path $source "*") -DestinationPath $zip -CompressionLevel Optimal

  $result = aws lambda update-function-code `
    --function-name $fn.name `
    --zip-file ("fileb://" + $zip) `
    --query "LastUpdateStatus" --output text 2>$null | Out-String

  if ($LASTEXITCODE -ne 0) {
    Write-Output ("FAILED: code update for " + $fn.name + " (aws exit " + $LASTEXITCODE + ")")
    exit 1
  }
  Write-Output ("{0,-30} code: {1}" -f $fn.name, $result.Trim())
}

# Wait for each code update to settle before changing configuration; Lambda
# rejects a concurrent configuration update.
foreach ($fn in $functions) {
  aws lambda wait function-updated --function-name $fn.name 2>$null | Out-Null
}

# Non-secret configuration only. GMAIL_ALLOW_ANY_SENDER matches the documented
# operator choice; MAILBOX_PROVIDER is pinned to the authorised mailbox.
$common = "RESOURCE_PREFIX=parcel-atlas,PIPELINE_SECRET_ARN=$secretArn,ARTIFACT_BUCKET=$bucket,PARCEL_ATLAS_BASE_URL=$($config['PARCEL_ATLAS_BASE_URL']),GMAIL_ALLOW_ANY_SENDER=true,MAILBOX_PROVIDER=gmail,NODE_OPTIONS=--enable-source-maps"

$configs = @(
  @{ name = "parcel-atlas-dispatch";      vars = "$common,REPORT_QUEUE_URL=$reportQueue" },
  @{ name = "parcel-atlas-report-worker"; vars = "$common,DELIVERY_QUEUE_URL=$deliveryQueue,COTALITY_MAX_STREET_PAGES=20,COTALITY_STREET_PAGE_CONCURRENCY=4" },
  @{ name = "parcel-atlas-delivery";      vars = "$common" }
)

foreach ($item in $configs) {
  $result = aws lambda update-function-configuration `
    --function-name $item.name `
    --environment ("Variables={" + $item.vars + "}") `
    --query "LastUpdateStatus" --output text 2>$null | Out-String
  if ($LASTEXITCODE -ne 0) {
    Write-Output ("FAILED: config update for " + $item.name + " (aws exit " + $LASTEXITCODE + ")")
    exit 1
  }
  Write-Output ("{0,-30} config: {1}" -f $item.name, $result.Trim())
}

foreach ($fn in $functions) {
  aws lambda wait function-updated --function-name $fn.name 2>$null | Out-Null
  $state = aws lambda get-function-configuration --function-name $fn.name --query "[State,LastUpdateStatus,CodeSize,LastModified]" --output text 2>$null | Out-String
  Write-Output ("{0,-30} {1}" -f $fn.name, $state.Trim())
}
