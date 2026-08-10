param(
  [Parameter(Mandatory)]
  [string]$AppName,
  [string]$ResourceGroup = 'rg-orca-relay',
  [string]$Location = 'koreacentral',
  [string]$PlanName = 'asp-orca-relay-f1'
)

$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path $PSScriptRoot
$stage = Join-Path $env:TEMP "orca-relay-$([guid]::NewGuid().ToString('N'))"
$zip = "$stage.zip"

function Invoke-Az {
  & az @args
  if ($LASTEXITCODE -ne 0) {
    throw "az failed: $($args -join ' ')"
  }
}

try {
  New-Item -ItemType Directory -Path $stage | Out-Null
  Copy-Item (Join-Path $sourceRoot 'mobile-reverse-relay.mjs') $stage
  Copy-Item (Join-Path $PSScriptRoot 'package.json') $stage
  Compress-Archive -Path "$stage\*" -DestinationPath $zip
  $routeBytes = New-Object byte[] 16
  $secretBytes = New-Object byte[] 32
  $random = [Security.Cryptography.RandomNumberGenerator]::Create()
  $random.GetBytes($routeBytes)
  $random.GetBytes($secretBytes)
  $random.Dispose()
  $route = [Convert]::ToBase64String($routeBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  $secret = [Convert]::ToBase64String($secretBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')

  Invoke-Az group create --name $ResourceGroup --location $Location --output none
  Invoke-Az appservice plan create --name $PlanName --resource-group $ResourceGroup --location $Location --sku F1 --is-linux --output none
  Invoke-Az webapp create --name $AppName --resource-group $ResourceGroup --plan $PlanName --runtime NODE:24-lts --output none
  Invoke-Az webapp config appsettings set --name $AppName --resource-group $ResourceGroup --settings "ORCA_RELAY_ROUTE=$route" "ORCA_RELAY_SECRET=$secret" SCM_DO_BUILD_DURING_DEPLOYMENT=true --output none
  Invoke-Az webapp config set --name $AppName --resource-group $ResourceGroup --web-sockets-enabled true --startup-file 'npm start' --output none
  Invoke-Az webapp deploy --name $AppName --resource-group $ResourceGroup --src-path $zip --type zip --clean true --restart true --track-status true --output none
  [pscustomobject]@{
    v = 1
    gateway = "wss://$AppName.azurewebsites.net"
    route = $route
    secret = $secret
  } | ConvertTo-Json
} finally {
  Remove-Item $stage, $zip -Recurse -Force -ErrorAction SilentlyContinue
}
