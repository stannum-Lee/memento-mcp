[CmdletBinding()]
param(
  [ValidateSet("top-right", "top-left")]
  [string]$Position = "top-right"
)

$ErrorActionPreference = "Stop"

$overlayScript = Join-Path $PSScriptRoot "local_status_overlay.ps1"
if (-not (Test-Path -Path $overlayScript -PathType Leaf)) {
  throw "Overlay script not found: $overlayScript"
}

$arguments = @(
  "-NoProfile",
  "-Sta",
  "-ExecutionPolicy", "Bypass",
  "-File", $overlayScript,
  "-Position", $Position
)

Start-Process -FilePath "powershell.exe" -ArgumentList $arguments -WorkingDirectory (Split-Path -Parent $PSScriptRoot) | Out-Null
