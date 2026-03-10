[CmdletBinding()]
param(
  [switch]$StartRedis
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $repoRoot ".env"
$logDir = Join-Path $repoRoot "logs"
$stdoutLog = Join-Path $logDir "overlay-server.stdout.log"
$stderrLog = Join-Path $logDir "overlay-server.stderr.log"

function Get-EnvValue {
  param(
    [string]$Path,
    [string]$Name,
    [string]$DefaultValue = ""
  )

  if (-not (Test-Path $Path)) {
    return $DefaultValue
  }

  foreach ($line in Get-Content $Path) {
    if (-not $line) { continue }
    if ($line.TrimStart().StartsWith("#")) { continue }
    $idx = $line.IndexOf("=")
    if ($idx -lt 1) { continue }
    $key = $line.Substring(0, $idx).Trim()
    if ($key -ne $Name) { continue }
    return $line.Substring($idx + 1).Trim()
  }

  return $DefaultValue
}

function Get-EnvFlag {
  param(
    [string]$Path,
    [string]$Name
  )

  return (Get-EnvValue -Path $Path -Name $Name).ToLowerInvariant() -eq "true"
}

function Test-TcpPort {
  param(
    [string]$HostName,
    [int]$Port
  )

  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect($HostName, $Port, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne(1000, $false)
    if (-not $ok) {
      return $false
    }

    $client.EndConnect($iar) | Out-Null
    return $true
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Resolve-NodeExecutable {
  $candidates = @()

  $nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($nodeCmd) {
    $candidates += $nodeCmd.Source
  }

  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd) {
    $candidates += $nodeCmd.Source
  }

  foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if ([string]::IsNullOrWhiteSpace($base)) { continue }
    $candidates += (Join-Path $base "nodejs\node.exe")
  }

  foreach ($candidate in $candidates | Select-Object -Unique) {
    if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path $candidate)) {
      return $candidate
    }
  }

  throw "node.exe not found. Install Node.js or add it to PATH."
}

function Stop-StaleHelperShells {
  $helperShells = @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        $_.ProcessId -ne $PID -and
        $_.Name -match "^(powershell|pwsh|cmd)\\.exe$" -and
        -not [string]::IsNullOrWhiteSpace($_.CommandLine) -and
        (
          $_.CommandLine -match [regex]::Escape("start_local_windows.ps1") -or
          $_.CommandLine -match [regex]::Escape("stop_local_windows.ps1")
        )
      }
  )

  foreach ($helper in $helperShells) {
    Stop-Process -Id $helper.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

$shouldStartRedis = $StartRedis.IsPresent -or (Get-EnvFlag -Path $envPath -Name "REDIS_ENABLED")

& (Join-Path $PSScriptRoot "setup_local_windows.ps1") -StartRedis:$shouldStartRedis
if ($LASTEXITCODE -ne 0) {
  throw "setup failed"
}

$port = [int](Get-EnvValue -Path $envPath -Name "PORT" -DefaultValue "57332")
Stop-StaleHelperShells

if (-not (Test-TcpPort -HostName "127.0.0.1" -Port $port)) {
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  Start-Process -FilePath (Resolve-NodeExecutable) `
    -ArgumentList "server.js" `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog | Out-Null
}

exit 0
