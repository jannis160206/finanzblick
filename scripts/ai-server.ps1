# Starts the local OpenVINO Model Server on the Intel NPU for Finanzblick.
param(
  [string]$Root = (Join-Path $env:LOCALAPPDATA "FinanzblickAI"),
  [int]$Port = 8000,
  [string]$Model = "OpenVINO/Qwen3-8B-int4-cw-ov",
  # Optional small model for routing, e.g. "OpenVINO/Qwen3-1.7B-int4-ov"; set FINANZBLICK_AI_ROUTER_MODEL to the same name.
  [string]$RouterModel = "",
  # Small embedding model for the local finance knowledge layer (CPU, ~600 MB); "" skips it, the app then searches by keyword only.
  [string]$EmbeddingModel = "OpenVINO/Qwen3-Embedding-0.6B-int8-ov",
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
function Add-Model([string]$Name) {
  & (Join-Path $ovms "ovms.exe") --pull --source_model $Name --model_repository_path models `
    --target_device $Device --task text_generation --tool_parser hermes3 --cache_dir .ov_cache `
    --enable_prefix_caching true --max_prompt_len 4000
  & (Join-Path $ovms "ovms.exe") --add_to_config --config_path $config --model_name $Name `
    --model_path ($Name -replace "/", "\")
}
function Add-EmbeddingModel([string]$Name) {
  & (Join-Path $ovms "ovms.exe") --pull --source_model $Name --model_repository_path models `
    --target_device CPU --task embeddings --pooling LAST --cache_dir .ov_cache
  & (Join-Path $ovms "ovms.exe") --add_to_config --config_path $config --model_name $Name `
    --model_path ($Name -replace "/", "\")
}
if (-not (Test-Path $config)) { Add-Model $Model }
if ($RouterModel -and -not ((Get-Content $config -Raw) -match [regex]::Escape("`"$RouterModel`""))) { Add-Model $RouterModel }
if ($EmbeddingModel -and -not ((Get-Content $config -Raw) -match [regex]::Escape("`"$EmbeddingModel`""))) { Add-EmbeddingModel $EmbeddingModel }
# Loopback only: booking texts must never leave this machine.
& (Join-Path $ovms "ovms.exe") --rest_port $Port --rest_bind_address 127.0.0.1 --config_path $config
