[CmdletBinding()]
param(
  [switch]$StartRedis,
  [switch]$NoRedis,
  [switch]$StartServer
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $repoRoot
$envPath = Join-Path $repoRoot ".env"

function Get-EnvMap {
  param([string]$Path)

  if (-not (Test-Path $Path)) {
    throw ".env file not found: $Path"
  }

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
    $candidates += (Join-Path $base 'nodejs\node.exe')
  }

  foreach ($candidate in $candidates | Select-Object -Unique) {
    if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path $candidate)) {
      return $candidate
    }
  }

  throw 'node.exe not found. Install Node.js or add it to PATH.'
}

function Invoke-Psql {
  param(
    [string]$PsqlPath,
    [hashtable]$EnvMap,
    [string]$Database,
    [string[]]$Args
  )

  $baseArgs = @(
    "-v", "ON_ERROR_STOP=1",
    "-h", $EnvMap["POSTGRES_HOST"],
    "-p", $EnvMap["POSTGRES_PORT"],
    "-U", $EnvMap["POSTGRES_USER"],
    "-d", $Database
  )

  & $PsqlPath @baseArgs @Args
  if ($LASTEXITCODE -ne 0) {
    throw "psql failed: $Database $Args"
  }
}

$envMap = Get-EnvMap -Path $envPath
$shouldStartRedis = if ($NoRedis) {
  $false
} elseif ($PSBoundParameters.ContainsKey("StartRedis")) {
  [bool]$StartRedis
} else {
  $true
}
$pgRoot = Resolve-ManagedPath -Value $envMap["MEMENTO_LOCAL_POSTGRES_RUNTIME"] -Fallback "..\\memento-postgres-runtime"
$pgData = Resolve-ManagedPath -Value $envMap["MEMENTO_LOCAL_POSTGRES_DATA"] -Fallback "..\\memento-postgres-data"
$pgLog = Join-Path $pgData "postgres.log"
$redisRoot = Resolve-ManagedPath -Value $envMap["MEMENTO_LOCAL_REDIS_DIR"] -Fallback "..\\redis-portable"
$redisData = Join-Path $redisRoot "data"
$redisExe = Join-Path $redisRoot "redis-server.exe"
$redisCli = Join-Path $redisRoot "redis-cli.exe"
$redisHost = if ($envMap.ContainsKey("REDIS_HOST") -and -not [string]::IsNullOrWhiteSpace($envMap["REDIS_HOST"])) {
  $envMap["REDIS_HOST"]
} else {
  "127.0.0.1"
}
$redisPort = if ($envMap.ContainsKey("REDIS_PORT") -and -not [string]::IsNullOrWhiteSpace($envMap["REDIS_PORT"])) {
  [int]$envMap["REDIS_PORT"]
} else {
  6379
}
$requiredKeys = @(
  "POSTGRES_HOST",
  "POSTGRES_PORT",
  "POSTGRES_DB",
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "DATABASE_URL",
  "EMBEDDING_DIMENSIONS"
)

foreach ($key in $requiredKeys) {
  if (-not $envMap.ContainsKey($key) -or [string]::IsNullOrWhiteSpace($envMap[$key])) {
    throw ".env value is missing: $key"
  }
}

if (-not (Test-Path (Join-Path $pgRoot "Library\\bin\\postgres.exe"))) {
  throw "Local PostgreSQL runtime not found: $pgRoot"
}

$psql = Join-Path $pgRoot "Library\\bin\\psql.exe"
$pgCtl = Join-Path $pgRoot "Library\\bin\\pg_ctl.exe"
$initdb = Join-Path $pgRoot "Library\\bin\\initdb.exe"
$createdb = Join-Path $pgRoot "Library\\bin\\createdb.exe"

if (-not (Test-Path (Join-Path $pgData "PG_VERSION"))) {
  New-Item -ItemType Directory -Force -Path $pgData | Out-Null
  $pwFile = Join-Path $workspaceRoot "memento-postgres-init.pw"
  Set-Content -Path $pwFile -Value $envMap["POSTGRES_PASSWORD"] -NoNewline -Encoding ascii
  try {
    & $initdb `
      -D $pgData `
      -U $envMap["POSTGRES_USER"] `
      --auth-local=scram-sha-256 `
      --auth-host=scram-sha-256 `
      --pwfile=$pwFile `
      --encoding=UTF8 | Out-Host
    if ($LASTEXITCODE -ne 0) {
      throw "initdb failed"
    }
  } finally {
    Remove-Item $pwFile -Force -ErrorAction SilentlyContinue
  }
}

$env:PGPASSWORD = $envMap["POSTGRES_PASSWORD"]

if (-not (Test-TcpPort -HostName $envMap["POSTGRES_HOST"] -Port ([int]$envMap["POSTGRES_PORT"]))) {
  & $pgCtl `
    -D $pgData `
    -l $pgLog `
    -w `
    -t 60 `
    -o "-p $($envMap["POSTGRES_PORT"]) -c listen_addresses=$($envMap["POSTGRES_HOST"])" `
    start | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "PostgreSQL start failed"
  }
}

$dbExists = [string](& $psql `
  -h $envMap["POSTGRES_HOST"] `
  -p $envMap["POSTGRES_PORT"] `
  -U $envMap["POSTGRES_USER"] `
  -d postgres `
  -tAc "SELECT 1 FROM pg_database WHERE datname = '$($envMap["POSTGRES_DB"])'")

if ([string]::IsNullOrWhiteSpace($dbExists)) {
  & $createdb `
    -h $envMap["POSTGRES_HOST"] `
    -p $envMap["POSTGRES_PORT"] `
    -U $envMap["POSTGRES_USER"] `
    $envMap["POSTGRES_DB"] | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "database creation failed"
  }
}

Invoke-Psql -PsqlPath $psql -EnvMap $envMap -Database $envMap["POSTGRES_DB"] -Args @("-c", "CREATE EXTENSION IF NOT EXISTS vector;")

$schemaExists = [string](& $psql `
  -h $envMap["POSTGRES_HOST"] `
  -p $envMap["POSTGRES_PORT"] `
  -U $envMap["POSTGRES_USER"] `
  -d $envMap["POSTGRES_DB"] `
  -tAc "SELECT 1 FROM pg_namespace WHERE nspname = 'agent_memory'")

if ([string]::IsNullOrWhiteSpace($schemaExists)) {
  $sqlFiles = @(
    "lib\\memory\\memory-schema.sql",
    "lib\\memory\\migration-001-temporal.sql",
    "lib\\memory\\migration-002-decay.sql",
    "lib\\memory\\migration-003-api-keys.sql",
    "lib\\memory\\migration-004-key-isolation.sql",
    "lib\\memory\\migration-005-gc-columns.sql",
    "lib\\memory\\migration-006-superseded-by-constraint.sql"
  )

  foreach ($sqlFile in $sqlFiles) {
    Invoke-Psql -PsqlPath $psql -EnvMap $envMap -Database $envMap["POSTGRES_DB"] -Args @("-f", (Join-Path $repoRoot $sqlFile))
  }
}

$embeddingDims = [int]$envMap["EMBEDDING_DIMENSIONS"]
$targetColType = if ($embeddingDims -gt 2000) { "halfvec($embeddingDims)" } else { "vector($embeddingDims)" }
$targetOpsType = if ($embeddingDims -gt 2000) { "halfvec_cosine_ops" } else { "vector_cosine_ops" }
$currentColType = [string](& $psql `
  -h $envMap["POSTGRES_HOST"] `
  -p $envMap["POSTGRES_PORT"] `
  -U $envMap["POSTGRES_USER"] `
  -d $envMap["POSTGRES_DB"] `
  -tAc "SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'agent_memory' AND c.relname = 'fragments' AND a.attname = 'embedding' AND a.attnum > 0 AND NOT a.attisdropped")

if ($currentColType.Trim() -ne $targetColType) {
  Invoke-Psql -PsqlPath $psql -EnvMap $envMap -Database $envMap["POSTGRES_DB"] -Args @(
    "-c",
    "DROP INDEX IF EXISTS agent_memory.idx_frag_embedding; ALTER TABLE agent_memory.fragments ALTER COLUMN embedding TYPE $targetColType USING NULL; CREATE INDEX IF NOT EXISTS idx_frag_embedding ON agent_memory.fragments USING hnsw (embedding $targetOpsType) WITH (m = 16, ef_construction = 64) WHERE embedding IS NOT NULL;"
  )
}

if ($shouldStartRedis) {
  if (-not (Test-Path $redisExe)) {
    throw "Redis portable runtime not found: $redisExe"
  }

  New-Item -ItemType Directory -Force -Path $redisData | Out-Null

  if (-not (Test-TcpPort -HostName $redisHost -Port $redisPort)) {
    Start-Process -FilePath $redisExe -ArgumentList @(
      "--bind", $redisHost,
      "--port", "$redisPort",
      "--dir", $redisData,
      "--dbfilename", "dump.rdb",
      "--logfile", (Join-Path $redisRoot "redis.log")
    ) -WorkingDirectory $redisRoot | Out-Null

    Start-Sleep -Seconds 1
    if (-not (Test-TcpPort -HostName $redisHost -Port $redisPort)) {
      throw "Redis start failed"
    }
  }

  if (Test-Path $redisCli) {
    & $redisCli -h $redisHost -p $redisPort ping | Out-Host
  }
}

Write-Host "Local PostgreSQL ready: $($envMap["POSTGRES_HOST"]):$($envMap["POSTGRES_PORT"]) / $($envMap["POSTGRES_DB"])"
if ($shouldStartRedis) {
  Write-Host "Redis ready: $redisHost`:$redisPort"
}

if ($StartServer) {
  Push-Location $repoRoot
  try {
    & (Resolve-NodeExecutable) server.js
  } finally {
    Pop-Location
  }
}

exit 0

