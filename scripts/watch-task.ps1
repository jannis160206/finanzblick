# Hintergrund-Agent of Finanzblick as a Windows Scheduled Task for the current user (no admin rights needed).
#   npm run watch:install     registers "Finanzblick Hintergrund-Agent" (daily 07:30 and at logon)
#   npm run watch:uninstall   removes it again
# The task calls this script with -Run, which runs `npm run watch:run` and appends a short log line.
param(
  [switch]$Install,
  [switch]$Uninstall,
  [switch]$Run,
  [string]$At = "07:30",
  [string]$NodeDir = ""
)
$ErrorActionPreference = "Stop"
$TaskName = "Finanzblick Hintergrund-Agent"
$Repo = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $env:LOCALAPPDATA "FinanzblickAI"

if ($Install) {
  $node = (Get-Command node -ErrorAction Stop).Source
  $script = Join-Path $PSScriptRoot "watch-task.ps1"
  $arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" -Run -NodeDir `"$(Split-Path -Parent $node)`""
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments -WorkingDirectory $Repo
  $user = "$env:USERDOMAIN\$env:USERNAME"
  $triggers = @(
    (New-ScheduledTaskTrigger -Daily -At $At),
    (New-ScheduledTaskTrigger -AtLogOn -User $user)
  )
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal `
    -Description "Prüft neue Buchungen, Preiserhöhungen und fällige Verträge und meldet sich nur bei Wichtigem." -Force | Out-Null
  Write-Host "Aufgabe '$TaskName' eingerichtet: täglich um $At und bei der Anmeldung. Entfernen mit: npm run watch:uninstall"
  exit 0
}

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Aufgabe '$TaskName' entfernt."
  } else {
    Write-Host "Aufgabe '$TaskName' ist nicht eingerichtet."
  }
  exit 0
}

if ($Run) {
  if ($NodeDir -and (Test-Path $NodeDir)) { $env:PATH = "$NodeDir;$env:PATH" }
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  Set-Location $Repo
  $output = & npm.cmd run --silent watch:run 2>&1 | Out-String
  $line = "$(Get-Date -Format s) exit=$LASTEXITCODE $($output.Trim() -replace '\s+', ' ')"
  Add-Content -Path (Join-Path $LogDir "watch.log") -Value $line -Encoding utf8
  exit $LASTEXITCODE
}

Write-Host "Verwendung: watch-task.ps1 -Install | -Uninstall | -Run"
