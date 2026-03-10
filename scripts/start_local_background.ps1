[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $repoRoot ".env"
$logDir = Join-Path $repoRoot "logs"
$stdoutLog = Join-Path $logDir "overlay-server.stdout.log"
$stderrLog = Join-Path $logDir "overlay-server.stderr.log"
$indicatorLog = Join-Path $logDir "overlay-indicator.log"

function Get-EnvMap {
  param([string]$Path)

  if (-not (Test-Path -Path $Path -PathType Leaf)) {
    throw ".env file not found: $Path"
  }

  $map = @{}
  foreach ($line in Get-Content -Path $Path) {
    if (-not $line) { continue }
    if ($line.TrimStart().StartsWith("#")) { continue }
    $idx = $line.IndexOf("=")
    if ($idx -lt 1) { continue }
    $map[$line.Substring(0, $idx).Trim()] = $line.Substring($idx + 1).Trim()
  }
  return $map
}

function Resolve-ManagedPath {
  param(
    [string]$Value,
    [string]$Fallback
  )

  $resolvedValue = if ([string]::IsNullOrWhiteSpace($Value)) { $Fallback } else { $Value }
  if ([System.IO.Path]::IsPathRooted($resolvedValue)) {
    return $resolvedValue
  }
  return [System.IO.Path]::GetFullPath((Join-Path $repoRoot $resolvedValue))
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

function Wait-ForPort {
  param(
    [string]$HostName,
    [int]$Port,
    [int]$TimeoutSeconds = 30
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-TcpPort -HostName $HostName -Port $Port) {
      return $true
    }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Resolve-NodeExecutable {
  $candidates = @()

  $nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($nodeCmd) { $candidates += $nodeCmd.Source }

  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd) { $candidates += $nodeCmd.Source }

  foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if ([string]::IsNullOrWhiteSpace($base)) { continue }
    $candidates += (Join-Path $base "nodejs\\node.exe")
  }

  foreach ($candidate in $candidates | Select-Object -Unique) {
    if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -Path $candidate)) {
      return $candidate
    }
  }

  throw "node.exe not found in PATH or standard install directories"
}

function Write-BootstrapLog {
  param([string]$Message)

  try {
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $timestamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    Add-Content -Path $indicatorLog -Value "[$timestamp] bootstrap: $Message"
  } catch {
    # Logging is best-effort only.
  }
}

function Wait-ForPostgresQuery {
  param(
    [string]$PsqlPath,
    [hashtable]$EnvMap,
    [int]$TimeoutSeconds = 20
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)

  while ((Get-Date) -lt $deadline) {
    & $PsqlPath `
      -h $EnvMap["POSTGRES_HOST"] `
      -p $EnvMap["POSTGRES_PORT"] `
      -U $EnvMap["POSTGRES_USER"] `
      -d postgres `
      -tAc "SELECT 1" *> $null

    if ($LASTEXITCODE -eq 0) {
      return $true
    }

    Start-Sleep -Milliseconds 500
  }

  return $false
}

trap {
  Write-BootstrapLog "error: $($_.Exception.Message)"
  break
}

$envMap = Get-EnvMap -Path $envPath
$env:PGPASSWORD = $envMap["POSTGRES_PASSWORD"]
$env:PGGSSENCMODE = "disable"
$env:PGSSLMODE = "disable"
Write-BootstrapLog "start requested"

$pgHost = $envMap["POSTGRES_HOST"]
$pgPort = [int]$envMap["POSTGRES_PORT"]
$pgRoot = Resolve-ManagedPath -Value $envMap["MEMENTO_LOCAL_POSTGRES_RUNTIME"] -Fallback "..\\memento-pg16-local"
$pgData = Resolve-ManagedPath -Value $envMap["MEMENTO_LOCAL_POSTGRES_DATA"] -Fallback "..\\memento-pg16-data"
$pgExe = Join-Path $pgRoot "Library\\bin\\postgres.exe"
$psql = Join-Path $pgRoot "Library\\bin\\psql.exe"

if (-not (Test-TcpPort -HostName $pgHost -Port $pgPort)) {
  if (-not (Test-Path -Path $pgExe -PathType Leaf)) {
    throw "Local PostgreSQL runtime not found: $pgExe"
  }

  Write-BootstrapLog "starting PostgreSQL"
  Start-Process -FilePath $pgExe `
    -ArgumentList @(
      "-D", $pgData,
      "-p", "$pgPort",
      "-c", "listen_addresses=$pgHost"
    ) `
    -WorkingDirectory $pgRoot `
    -WindowStyle Hidden | Out-Null
}

if (-not (Wait-ForPort -HostName $pgHost -Port $pgPort -TimeoutSeconds 20)) {
  throw "PostgreSQL did not start on $pgHost`:$pgPort"
}
Write-BootstrapLog "PostgreSQL port ready"

if ((Test-Path -Path $psql -PathType Leaf) -and -not (Wait-ForPostgresQuery -PsqlPath $psql -EnvMap $envMap -TimeoutSeconds 20)) {
  throw "PostgreSQL is listening but not yet accepting queries"
}
Write-BootstrapLog "PostgreSQL query ready"

$redisEnabled = $envMap["REDIS_ENABLED"] -eq "true"
if ($redisEnabled) {
  $redisHost = $envMap["REDIS_HOST"]
  $redisPort = [int]$envMap["REDIS_PORT"]
  $redisRoot = Resolve-ManagedPath -Value $envMap["MEMENTO_LOCAL_REDIS_DIR"] -Fallback "..\\redis-portable"
  $redisExe = Join-Path $redisRoot "redis-server.exe"
  $redisData = Join-Path $redisRoot "data"

  if (-not (Test-TcpPort -HostName $redisHost -Port $redisPort)) {
    Write-BootstrapLog "starting Redis"
    New-Item -ItemType Directory -Force -Path $redisData | Out-Null
    Start-Process -FilePath $redisExe `
      -ArgumentList @(
        "--bind", $redisHost,
        "--port", "$redisPort",
        "--dir", $redisData,
        "--dbfilename", "dump.rdb",
        "--logfile", (Join-Path $redisRoot "redis.log")
      ) `
      -WorkingDirectory $redisRoot `
      -WindowStyle Hidden | Out-Null
  }

  if (-not (Wait-ForPort -HostName $redisHost -Port $redisPort -TimeoutSeconds 15)) {
    throw "Redis start failed"
  }
  Write-BootstrapLog "Redis ready"
}

$serverPort = [int]$envMap["PORT"]
if (-not (Test-TcpPort -HostName "127.0.0.1" -Port $serverPort)) {
  Write-BootstrapLog "starting server"
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $nodeExe = Resolve-NodeExecutable
  $serverScript = Join-Path $repoRoot "server.js"
  $cmdArgs = '/d /c start "" /b "' + $nodeExe + '" "' + $serverScript + '" 1>>"' + $stdoutLog + '" 2>>"' + $stderrLog + '"'
  Start-Process -FilePath "cmd.exe" `
    -ArgumentList $cmdArgs `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden | Out-Null
}

if (-not (Wait-ForPort -HostName "127.0.0.1" -Port $serverPort -TimeoutSeconds 30)) {
  throw "Memento server did not start on port $serverPort"
}
Write-BootstrapLog "server ready"

exit 0
