# Creates a local TLS certificate for the Enable Banking return URL https://localhost:3443/api/bank/callback
# and trusts it for the current Windows user (Windows asks once for confirmation).
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root ".local-data\bank-callback.pfx"
New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
$cert = New-SelfSignedCertificate -Subject "CN=localhost" `
  -CertStoreLocation "Cert:\CurrentUser\My" -KeyExportPolicy Exportable -KeyAlgorithm RSA -KeyLength 2048 `
  -NotAfter (Get-Date).AddYears(5) -FriendlyName "Finanzblick Bank-Rücksprung" `
  -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.1", "2.5.29.17={text}DNS=localhost&IPAddress=127.0.0.1")
$password = ConvertTo-SecureString -String "finanzblick" -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath $target -Password $password | Out-Null
$cer = Join-Path $env:TEMP "finanzblick-bank-callback.cer"
Export-Certificate -Cert $cert -FilePath $cer | Out-Null
Import-Certificate -FilePath $cer -CertStoreLocation "Cert:\CurrentUser\Root" | Out-Null
Remove-Item $cer
Write-Host "Zertifikat erstellt: $target"
