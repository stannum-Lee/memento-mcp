[CmdletBinding()]
param(
  [switch]$KeepOverlay
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $repoRoot ".env"
$port = 57332
$pgRoot = $null
$pgData = $null
$redisCli = $null

function Get-EnvMap {
  param([string]$Path)

  $map = @{}
  foreach ($line in Get-Content $Path) {
    if (-not $line) { continue }
    if ($line.TrimStart().StartsWith("#")) { continue }
    $idx = $line.IndexOf("=")
    if ($idx -lt 1) { continue }
    $key = $line.Substring(0, $idx).Trim()
    $value = $line.Substring($idx + 1)
    $map[$key] = $value
  }
  return $map
}

function Resolve-ManagedPath {
  param(
    [string]$Value,
    [string]$Fallback
  )

  $resolvedValue = $Value
  if ([string]::IsNullOrWhiteSpace($resolvedValue)) {
    $resolvedValue = $Fallback
  }

  if ([System.IO.Path]::IsPathRooted($resolvedValue)) {
    return $resolvedValue
  }

  return [System.IO.Path]::GetFullPath((Join-Path $repoRoot $resolvedValue))
}

function Stop-MementoHelperShells {
  param(
    [int]$CurrentPid = $PID,
    [switch]$KeepOverlay
  )

  $patterns = @(
    "(?i)memento-mcp\\scripts\\start_local_background\.ps1",
    "(?i)memento-mcp\\scripts\\start_local_overlay_host\.ps1",
    "(?i)memento-mcp\\scripts\\start_local_windows\.ps1",
    "(?i)memento-mcp\\scripts\\stop_local_windows\.ps1",
    "(?i)memento-mcp\\scripts\\start_local_overlay(?:_left)?\.vbs",
    "(?i)memento-mcp\\scripts\\stop_local_silent\.vbs",
    "(?i)cmd\.exe.+memento-mcp\\server\.js"
  )

  if (-not $KeepOverlay) {
    $patterns = @(
      "(?i)memento-mcp\\scripts\\local_status_overlay\.ps1"
    ) + $patterns
  }

  $helpers = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessId -ne $CurrentPid -and
    $_.Name -match '^(powershell|pwsh|cmd|wscript|cscript)\.exe$' -and
    -not [string]::IsNullOrWhiteSpace($_.CommandLine)
  }

  foreach ($helper in $helpers) {
    foreach ($pattern in $patterns) {
      if ($helper.CommandLine -match $pattern) {
        Stop-Process -Id $helper.ProcessId -Force -ErrorAction SilentlyContinue
        break
      }
    }
  }
}

function Get-MementoServerListenerPid {
  param([int]$Port)

  $listenerPid = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -First 1

  if (-not $listenerPid) {
    return $null
  }

  $listenerProc = Get-CimInstance Win32_Process -Filter "ProcessId = $listenerPid" -ErrorAction SilentlyContinue
  if (-not $listenerProc) {
    return $null
  }

  if ($listenerProc.Name -match '^node(\.exe)?$' -and $listenerProc.CommandLine -match '(?i)memento-mcp\\server\.js') {
    return $listenerPid
  }

  return $null
}

if (Test-Path $envPath) {
  $envMap = Get-EnvMap -Path $envPath
  if ($envMap.ContainsKey("PORT")) {
    $port = [int]$envMap["PORT"]
  }
  $pgRoot = Resolve-ManagedPath -Value $envMap["MEMENTO_LOCAL_POSTGRES_RUNTIME"] -Fallback "..\\memento-postgres-runtime"
  $pgData = Resolve-ManagedPath -Value $envMap["MEMENTO_LOCAL_POSTGRES_DATA"] -Fallback "..\\memento-postgres-data"
  $redisCli = Join-Path (Resolve-ManagedPath -Value $envMap["MEMENTO_LOCAL_REDIS_DIR"] -Fallback "..\\redis-portable") "redis-cli.exe"
}

$listenerPid = Get-MementoServerListenerPid -Port $port

if ($listenerPid) {
  Stop-Process -Id $listenerPid -Force -ErrorAction SilentlyContinue
}

if (Test-Path (Join-Path $pgData "PG_VERSION")) {
  & (Join-Path $pgRoot "Library\\bin\\pg_ctl.exe") -D $pgData stop -m fast | Out-Host
}

if (Test-Path $redisCli) {
  $redisHost = if ($envMap.ContainsKey("REDIS_HOST")) { $envMap["REDIS_HOST"] } else { "127.0.0.1" }
  $redisPort = if ($envMap.ContainsKey("REDIS_PORT")) { $envMap["REDIS_PORT"] } else { "6379" }
  try {
    & $redisCli -h $redisHost -p $redisPort shutdown nosave *> $null
  } catch {
    # Redis is optional for the local stack; ignore "already stopped" cases.
  }
}

Stop-MementoHelperShells -KeepOverlay:$KeepOverlay

exit 0
