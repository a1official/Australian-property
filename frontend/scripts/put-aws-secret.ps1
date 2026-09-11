# Populates the AWS pipeline secret from the local .env.
#
# Values are passed to the AWS CLI through a temporary file that is deleted
# immediately afterwards, so no secret appears in a command line, process list,
# or console output. Reports key names and lengths only.

$ErrorActionPreference = "Stop"

$envFile = "D:\Realstate\.env"
$config = @{}
foreach ($line in Get-Content $envFile) {
  if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
    $config[$Matches[1]] = $Matches[2].Trim().Trim('"').Trim("'")
  }
}

$env:AWS_ACCESS_KEY_ID = $config["AWS_ACCESS_KEY_ID"]
$env:AWS_SECRET_ACCESS_KEY = $config["AWS_SECRET_ACCESS_KEY"]
$env:AWS_DEFAULT_REGION = if ($config["AWS_REGION"]) { $config["AWS_REGION"] } else { "ap-southeast-2" }

# Only the keys the Lambdas actually read.
$required = @(
  "DATABASE_URL",
  "GMAIL_CLIENT_ID",
  "GMAIL_CLIENT_SECRET",
  "GMAIL_TOKEN_ENCRYPTION_KEY",
  "CORELOGIC_CLIENT_ID",
  "CORELOGIC_CLIENT_SECRET"
)
# GMAIL_REDIRECT_URI is not needed by the refresh grant the Lambdas use, but it
# is stored so any authorization-code path behaves identically to Vercel.
$optional = @("CORELOGIC_SANDBOX_BASE_URL", "BLOB_READ_WRITE_TOKEN", "PARCEL_ATLAS_BASE_URL", "GMAIL_REDIRECT_URI")

$payload = [ordered]@{}
$missing = @()
foreach ($key in $required) {
  if ($config[$key]) { $payload[$key] = $config[$key] } else { $missing += $key }
}
foreach ($key in $optional) {
  if ($config[$key]) { $payload[$key] = $config[$key] }
}

# BLOB_READ_WRITE_TOKEN lives in .env.local for local development.
if (-not $payload["BLOB_READ_WRITE_TOKEN"]) {
  $localFile = "D:\Realstate\frontend\.env.local"
  if (Test-Path $localFile) {
    $match = Select-String -Path $localFile -Pattern '^\s*BLOB_READ_WRITE_TOKEN\s*=\s*(.+)$'
    if ($match) { $payload["BLOB_READ_WRITE_TOKEN"] = $match.Matches.Groups[1].Value.Trim().Trim('"').Trim("'") }
  }
}

if ($missing.Count -gt 0) {
  Write-Output ("MISSING required keys: " + ($missing -join ", "))
  exit 1
}

Write-Output "keys to store (lengths only):"
foreach ($key in $payload.Keys) {
  Write-Output ("  {0,-30} {1} chars" -f $key, $payload[$key].Length)
}

$temp = [System.IO.Path]::GetTempFileName()
try {
  # Write compact JSON without a BOM; the CLI rejects a BOM in file:// input.
  $json = ($payload | ConvertTo-Json -Compress -Depth 3)
  [System.IO.File]::WriteAllText($temp, $json, (New-Object System.Text.UTF8Encoding($false)))

  $result = aws secretsmanager put-secret-value `
    --secret-id "parcel-atlas/pipeline" `
    --secret-string ("file://" + $temp) `
    --query "VersionId" --output text 2>&1 | Out-String

  if ($result -match "error|Exception") {
    Write-Output ("FAILED: " + $result.Trim())
    exit 1
  }
  Write-Output ("stored version: " + $result.Trim())
} finally {
  Remove-Item $temp -Force -ErrorAction SilentlyContinue
}

# Read back key names only, to confirm the write landed.
$check = aws secretsmanager get-secret-value --secret-id "parcel-atlas/pipeline" --query SecretString --output text 2>&1 | Out-String
try {
  $keys = ($check | ConvertFrom-Json).PSObject.Properties.Name
  Write-Output ("verified keys in AWS: " + ($keys -join ", "))
} catch {
  Write-Output "WARNING: could not verify the stored secret."
  exit 1
}
