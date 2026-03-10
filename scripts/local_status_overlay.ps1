[CmdletBinding()]
param(
  [ValidateSet("top-right", "top-left")]
  [string]$Position = "top-right"
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class ConsoleWindow {
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@

[void][ConsoleWindow]::ShowWindow([ConsoleWindow]::GetConsoleWindow(), 0)

$repoRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $repoRoot ".env"
$logDir = Join-Path $repoRoot "logs"
$stdoutLog = Join-Path $logDir "overlay-server.stdout.log"
$stderrLog = Join-Path $logDir "overlay-server.stderr.log"
$indicatorLog = Join-Path $logDir "overlay-indicator.log"
$overlayWindowTitle = "Memento Status"
$overlayMutexName = "Local\MementoStatusOverlay"
$backgroundBootstrapScript = Join-Path $PSScriptRoot "start_local_background.ps1"
$overlayMutexCreated = $false
$overlayMutex = New-Object System.Threading.Mutex($true, $overlayMutexName, [ref]$overlayMutexCreated)

function Get-EnvMap {
  param([string]$Path)

  $map = @{}
  foreach ($line in Get-Content -Path $Path) {
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

function Write-IndicatorLog {
  param([string]$Message)

  try {
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $timestamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    Add-Content -Path $indicatorLog -Value "[$timestamp] $Message"
  } catch {
    # Keep the UI path resilient even if logging fails.
  }
}

if (-not $overlayMutexCreated) {
  try {
    $existingWindow = [ConsoleWindow]::FindWindow($null, $overlayWindowTitle)
    if ($existingWindow -ne [IntPtr]::Zero) {
      [void][ConsoleWindow]::ShowWindow($existingWindow, 9)
      [void][ConsoleWindow]::SetForegroundWindow($existingWindow)
      Write-IndicatorLog "existing overlay window restored"
    }
  } finally {
    $overlayMutex.Dispose()
  }
  exit 0
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

function Stop-StaleHelperShells {
  param(
    [int]$CurrentPid,
    [int]$MinAgeSeconds = 90
  )

  $helperPatterns = @(
    "(?i)memento-mcp\\scripts\\start_local_background\.ps1",
    "(?i)memento-mcp\\scripts\\start_local_overlay_host\.ps1",
    "(?i)memento-mcp\\scripts\\start_local_windows\.ps1",
    "(?i)memento-mcp\\scripts\\stop_local_windows\.ps1",
    "(?i)memento-mcp\\scripts\\start_local_overlay(?:_left)?\.vbs",
    "(?i)memento-mcp\\scripts\\stop_local_silent\.vbs",
    "(?i)cmd\.exe.+memento-mcp\\server\.js"
  )

  $shells = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessId -ne $CurrentPid -and
    $_.Name -match '^(powershell|pwsh|cmd|wscript|cscript)\.exe$' -and
    -not [string]::IsNullOrWhiteSpace($_.CommandLine)
  }

  foreach ($shell in $shells) {
    $ageSeconds = $MinAgeSeconds
    if ($shell.CreationDate) {
      try {
        $createdAt = [System.Management.ManagementDateTimeConverter]::ToDateTime($shell.CreationDate)
        $ageSeconds = ((Get-Date) - $createdAt).TotalSeconds
      } catch {
        $ageSeconds = $MinAgeSeconds
      }
    }

    if ($ageSeconds -lt $MinAgeSeconds) {
      continue
    }

    foreach ($pattern in $helperPatterns) {
      if ($shell.CommandLine -match $pattern) {
        Stop-Process -Id $shell.ProcessId -Force -ErrorAction SilentlyContinue
        break
      }
    }
  }
}

function Get-ActiveStopHelpers {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -match '^(powershell|pwsh|cmd|wscript|cscript)\.exe$' -and
    -not [string]::IsNullOrWhiteSpace($_.CommandLine) -and
    (
      $_.CommandLine -match '(?i)memento-mcp\\scripts\\stop_local_windows\.ps1' -or
      $_.CommandLine -match '(?i)memento-mcp\\scripts\\stop_local_silent\.vbs'
    )
  }
}

function Wait-ForStopHelpersToExit {
  param([int]$TimeoutSeconds = 10)

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (-not (Get-ActiveStopHelpers)) {
      return $true
    }

    Start-Sleep -Milliseconds 300
  }

  return $false
}

function Get-BootstrapProcess {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -match '^(powershell|pwsh)\.exe$' -and
    -not [string]::IsNullOrWhiteSpace($_.CommandLine) -and
    $_.CommandLine -match '(?i)memento-mcp\\scripts\\start_local_background\.ps1'
  } | Select-Object -First 1
}

function Start-BackgroundBootstrap {
  if (-not (Test-Path -Path $backgroundBootstrapScript -PathType Leaf)) {
    throw "Bootstrap script not found: $backgroundBootstrapScript"
  }

  $existingBootstrap = Get-BootstrapProcess
  if ($existingBootstrap) {
    Write-IndicatorLog "bootstrap already active"
    return $existingBootstrap.ProcessId
  }

  Start-Process -FilePath "powershell.exe" `
    -ArgumentList @(
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-WindowStyle", "Hidden",
      "-File", $backgroundBootstrapScript
    ) `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden | Out-Null

  Write-IndicatorLog "background bootstrap launched"
  return $null
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
    $candidates += (Join-Path $base "nodejs\\node.exe")
  }

  foreach ($candidate in $candidates | Select-Object -Unique) {
    if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -Path $candidate)) {
      return $candidate
    }
  }

  throw "node.exe not found in PATH or standard install directories"
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
    [int]$TimeoutSeconds = 20
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

function Ensure-PostgresRunning {
  param([hashtable]$EnvMap)

  $hostName = $EnvMap["POSTGRES_HOST"]
  $port = [int]$EnvMap["POSTGRES_PORT"]
  if (Test-TcpPort -HostName $hostName -Port $port) {
    return
  }

  $pgRoot = Resolve-ManagedPath -Value $EnvMap["MEMENTO_LOCAL_POSTGRES_RUNTIME"] -Fallback "..\\memento-pg16-local"
  $pgData = Resolve-ManagedPath -Value $EnvMap["MEMENTO_LOCAL_POSTGRES_DATA"] -Fallback "..\\memento-pg16-data"
  $pgCtl = Join-Path $pgRoot "Library\\bin\\pg_ctl.exe"
  $pgLog = Join-Path $pgData "postgres.log"

  if (-not (Test-Path -Path $pgCtl)) {
    throw "Local PostgreSQL runtime not found: $pgCtl"
  }

  & $pgCtl `
    -D $pgData `
    -l $pgLog `
    -o "-p $port -c listen_addresses=$hostName" `
    start | Out-Null

  if ($LASTEXITCODE -ne 0) {
    throw "PostgreSQL start failed"
  }

  if (-not (Wait-ForPort -HostName $hostName -Port $port -TimeoutSeconds 20)) {
    throw "PostgreSQL did not start on $hostName`:$port"
  }
}

function Ensure-RedisRunning {
  param([hashtable]$EnvMap)

  if ($EnvMap["REDIS_ENABLED"] -ne "true") {
    return
  }

  $hostName = $EnvMap["REDIS_HOST"]
  $port = [int]$EnvMap["REDIS_PORT"]
  if (Test-TcpPort -HostName $hostName -Port $port) {
    return
  }

  $redisRoot = Resolve-ManagedPath -Value $EnvMap["MEMENTO_LOCAL_REDIS_DIR"] -Fallback "..\\redis-portable"
  $redisExe = Join-Path $redisRoot "redis-server.exe"
  $redisData = Join-Path $redisRoot "data"
  $redisLog = Join-Path $redisRoot "redis.log"

  if (-not (Test-Path -Path $redisExe)) {
    throw "Redis runtime not found: $redisExe"
  }

  New-Item -ItemType Directory -Force -Path $redisData | Out-Null

  Start-Process -FilePath $redisExe `
    -ArgumentList @(
      "--bind", $hostName,
      "--port", "$port",
      "--dir", $redisData,
      "--dbfilename", "dump.rdb",
      "--logfile", $redisLog
    ) `
    -WindowStyle Hidden `
    -WorkingDirectory $redisRoot | Out-Null

  if (-not (Wait-ForPort -HostName $hostName -Port $port -TimeoutSeconds 15)) {
    throw "Redis did not start on $hostName`:$port"
  }
}

function Ensure-ServerRunning {
  param([hashtable]$EnvMap)

  $serverPort = [int]$EnvMap["PORT"]
  if (Test-TcpPort -HostName "127.0.0.1" -Port $serverPort) {
    return
  }

  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $nodeExe = Resolve-NodeExecutable
  $serverScript = Join-Path $repoRoot "server.js"
  $cmdArgs = '/d /c start "" /b "' + $nodeExe + '" "' + $serverScript + '" 1>>"' + $stdoutLog + '" 2>>"' + $stderrLog + '"'
  Start-Process -FilePath "cmd.exe" `
    -ArgumentList $cmdArgs `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden | Out-Null

  if (-not (Wait-ForPort -HostName "127.0.0.1" -Port $serverPort -TimeoutSeconds 30)) {
    throw "Memento server did not start on port $serverPort"
  }
}

function Get-HealthState {
  param([string]$HealthUrl)

  try {
    $request = [System.Net.WebRequest]::Create($HealthUrl)
    $request.Timeout = 1500
    $response = [System.Net.HttpWebResponse]$request.GetResponse()
    try {
      $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
      $payload = $reader.ReadToEnd() | ConvertFrom-Json
    } finally {
      if ($reader) { $reader.Dispose() }
      $response.Dispose()
    }

    if ($payload.status -eq "healthy") {
      return @{ state = "ON"; color = "#34C759"; detail = "Healthy" }
    }

    return @{ state = "WARN"; color = "#FFB020"; detail = "Status: $($payload.status)" }
  } catch {
    return @{ state = "OFF"; color = "#FF5F57"; detail = "Offline" }
  }
}

function Start-MementoRuntime {
  $script:startupError = $null
  Write-IndicatorLog "runtime start requested"

  try {
    if (-not (Wait-ForStopHelpersToExit -TimeoutSeconds 10)) {
      Write-IndicatorLog "stop helpers still active before startup"
    }
    Start-BackgroundBootstrap | Out-Null
  } catch {
    $script:startupError = $_.Exception.Message
    Write-IndicatorLog "startup error: $($script:startupError)"
  }
}

function Update-Indicator {
  param(
    [System.Windows.Forms.Label]$DotLabel,
    [System.Windows.Forms.Label]$StatusLabel,
    [System.Windows.Forms.Label]$DetailLabel,
    [hashtable]$StateInfo
  )

  $DotLabel.ForeColor = [System.Drawing.ColorTranslator]::FromHtml($StateInfo.color)
  $StatusLabel.Text = "Memento $($StateInfo.state)"
  $DetailLabel.Text = $StateInfo.detail
}

if (-not (Test-Path -Path $envPath)) {
  throw ".env file not found: $envPath"
}

$envMap = Get-EnvMap -Path $envPath
$healthUrl = "http://127.0.0.1:$($envMap["PORT"])/health"
$script:startupError = $null
$script:isStarting = $false

Stop-StaleHelperShells -CurrentPid $PID

$form = New-Object System.Windows.Forms.Form
$form.Text = $overlayWindowTitle
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedSingle
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.ShowInTaskbar = $true
$form.ControlBox = $true
$form.MinimizeBox = $true
$form.MaximizeBox = $false
$form.ShowIcon = $false
$form.TopMost = $true
$form.BackColor = [System.Drawing.Color]::FromArgb(30, 30, 30)
$form.Size = New-Object System.Drawing.Size(250, 82)
$form.Padding = New-Object System.Windows.Forms.Padding(8, 6, 8, 6)
$form.Opacity = 0.92

$workingArea = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$x = if ($Position -eq "top-left") { 10 } else { $workingArea.Right - $form.Width - 10 }
$form.Location = New-Object System.Drawing.Point($x, 10)

$dotLabel = New-Object System.Windows.Forms.Label
$dotLabel.AutoSize = $true
$dotLabel.Font = New-Object System.Drawing.Font("Segoe UI Symbol", 13, [System.Drawing.FontStyle]::Regular)
$dotLabel.Location = New-Object System.Drawing.Point(10, 12)
$dotLabel.Text = [char]0x25CF

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.AutoSize = $true
$statusLabel.Font = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
$statusLabel.ForeColor = [System.Drawing.Color]::White
$statusLabel.Location = New-Object System.Drawing.Point(32, 15)

$detailLabel = New-Object System.Windows.Forms.Label
$detailLabel.AutoSize = $true
$detailLabel.Font = New-Object System.Drawing.Font("Segoe UI", 8.5, [System.Drawing.FontStyle]::Regular)
$detailLabel.ForeColor = [System.Drawing.Color]::FromArgb(220, 220, 220)
$detailLabel.Location = New-Object System.Drawing.Point(33, 39)

$form.Controls.Add($dotLabel)
$form.Controls.Add($statusLabel)
$form.Controls.Add($detailLabel)

$contextMenu = New-Object System.Windows.Forms.ContextMenuStrip
$startItem = $contextMenu.Items.Add("Start / Recover")
$stopItem = $contextMenu.Items.Add("Stop")
$healthItem = $contextMenu.Items.Add("Open Health")
$exitItem = $contextMenu.Items.Add("Hide Indicator")
$form.ContextMenuStrip = $contextMenu

$updateAction = {
  $liveState = Get-HealthState -HealthUrl $healthUrl
  if ($liveState.state -ne "OFF") {
    $script:startupError = $null
    $stateInfo = $liveState
  } elseif ($script:isStarting -or (Get-BootstrapProcess)) {
    $stateInfo = @{ state = "BOOT"; color = "#4DA3FF"; detail = "Starting local runtime..." }
  } elseif ($script:startupError) {
    $stateInfo = @{ state = "OFF"; color = "#FF5F57"; detail = $script:startupError }
  } else {
    $stateInfo = $liveState
  }

  Update-Indicator -DotLabel $dotLabel -StatusLabel $statusLabel -DetailLabel $detailLabel -StateInfo $stateInfo
}

$startItem.Add_Click({
  try {
    $script:isStarting = $true
    $script:startupError = $null
    Stop-StaleHelperShells -CurrentPid $PID
    Update-Indicator `
      -DotLabel $dotLabel `
      -StatusLabel $statusLabel `
      -DetailLabel $detailLabel `
      -StateInfo @{ state = "BOOT"; color = "#4DA3FF"; detail = "Starting local runtime..." }
    $form.Refresh()
    Start-MementoRuntime
  } finally {
    $script:isStarting = $false
  }

  & $updateAction
})

$stopItem.Add_Click({
  Start-Process -FilePath "powershell.exe" `
    -ArgumentList @(
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-WindowStyle", "Hidden",
      "-File", (Join-Path $PSScriptRoot "stop_local_windows.ps1"),
      "-KeepOverlay"
    ) `
    -WindowStyle Hidden | Out-Null
  Start-Sleep -Seconds 2
  & $updateAction
})

$healthItem.Add_Click({
  Start-Process $healthUrl | Out-Null
})

$exitItem.Add_Click({
  $form.Close()
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick($updateAction)
$timer.Start()

$startupTimer = New-Object System.Windows.Forms.Timer
$startupTimer.Interval = 250
$startupTimer.Add_Tick({
  $startupTimer.Stop()
  try {
    $script:isStarting = $true
    Update-Indicator `
      -DotLabel $dotLabel `
      -StatusLabel $statusLabel `
      -DetailLabel $detailLabel `
      -StateInfo @{ state = "BOOT"; color = "#4DA3FF"; detail = "Starting local runtime..." }
    $form.Refresh()
    Start-MementoRuntime
  } finally {
    $script:isStarting = $false
  }

  & $updateAction
})

$form.Add_Shown({
  $startupTimer.Start()
  & $updateAction
})

try {
  & $updateAction
  [void]$form.ShowDialog()
} finally {
  Write-IndicatorLog "overlay host exiting"
  try { $startupTimer.Stop() } catch {}
  try { $startupTimer.Dispose() } catch {}
  try { $timer.Stop() } catch {}
  try { $timer.Dispose() } catch {}
  try { $contextMenu.Dispose() } catch {}
  try { $form.Dispose() } catch {}
  try {
    if ($overlayMutex) {
      $overlayMutex.ReleaseMutex()
      $overlayMutex.Dispose()
    }
  } catch {}
}
