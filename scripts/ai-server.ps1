# Starts the local OpenVINO Model Server on the Intel NPU for Finanzblick.
param(
  [string]$Root = (Join-Path $env:LOCALAPPDATA "FinanzblickAI"),
  [int]$Port = 8000,
  [string]$Model = "OpenVINO/Qwen3-8B-int4-cw-ov",
  [string]$Device = "NPU"
)
$ErrorActionPreference = "Stop"
$ovms = Join-Path $Root "ovms"
if (-not (Test-Path (Join-Path $ovms "ovms.exe"))) {
  throw "OVMS fehlt in $ovms. Siehe docs/local-ai.md (Einrichtung)."
}
Set-Location $Root
. (Join-Path $ovms "setupvars.ps1")
$config = Join-Path $Root "models\config.json"
if (-not (Test-Path $config)) {
  & (Join-Path $ovms "ovms.exe") --pull --source_model $Model --model_repository_path models `
    --target_device $Device --task text_generation --tool_parser hermes3 --cache_dir .ov_cache `
    --enable_prefix_caching true --max_prompt_len 4000
  & (Join-Path $ovms "ovms.exe") --add_to_config --config_path $config --model_name $Model `
    --model_path ($Model -replace "/", "\")
}
# Loopback only: booking texts must never leave this machine.
& (Join-Path $ovms "ovms.exe") --rest_port $Port --rest_bind_address 127.0.0.1 --config_path $config
