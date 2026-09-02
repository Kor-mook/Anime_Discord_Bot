# Starts, restarts, or stops the local Seline Discord bot.
[CmdletBinding()]
param(
    [ValidateSet('start', 'stop', 'restart', 'logs', IgnoreCase = $true)]
    [string]$Action = 'start'
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$repositoryRoot = $PSScriptRoot
$environmentFile = Join-Path $repositoryRoot '.env'

$runtimeDirectory = Join-Path $repositoryRoot 'data\\runtime'
$standardOutputLog = Join-Path $runtimeDirectory 'seline-console.log'
$standardErrorLog = Join-Path $runtimeDirectory 'seline-console-error.log'
function Get-SelineProcesses {
    return @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -ieq 'node.exe' -and
        $_.CommandLine -match [regex]::Escape($repositoryRoot) -and
        $_.CommandLine -match 'src[\\/]bot[\\/]index\.ts'
    })
}

function Stop-SelineProcesses {
    param([Microsoft.Management.Infrastructure.CimInstance[]]$Processes)

    # taskkill /T stops a process and every child below it. Kill only roots from
    # this snapshot, otherwise a root can remove a child before its own turn.
    $processIds = @($Processes | ForEach-Object { $_.ProcessId })
    $rootProcesses = @($Processes | Where-Object { $_.ParentProcessId -notin $processIds })
    if (-not $rootProcesses) {
        $rootProcesses = $Processes
    }

    foreach ($process in $rootProcesses) {
        if (-not (Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue)) {
            continue
        }

        # Suppress taskkill's stderr so a stale PID can be handled by exit code.
        $taskkillOutput = & taskkill.exe /PID $process.ProcessId /T /F 2>$null
        if ($LASTEXITCODE -ne 0) {
            if (-not (Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue)) {
                Write-Verbose "Seline process $($process.ProcessId) had already stopped."
                continue
            }

            throw "Could not stop Seline process $($process.ProcessId): $taskkillOutput"
        }
    }

    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline) {
        $remaining = $Processes | Where-Object {
            Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
        }
        if (-not $remaining) {
            return
        }
        Start-Sleep -Milliseconds 250
    }

    throw 'Seline processes did not stop within 10 seconds.'
}

function Import-SelineEnvironment {
    if (-not (Test-Path -LiteralPath $environmentFile)) {
        throw "Missing environment file: $environmentFile"
    }

    Get-Content -LiteralPath $environmentFile | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith('#')) {
            return
        }

        if ($line -match '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
            $name = $matches[1]
            $value = $matches[2].Trim()
            if ($value.Length -ge 2 -and (
                ($value.StartsWith('"') -and $value.EndsWith('"')) -or
                ($value.StartsWith("'") -and $value.EndsWith("'"))
            )) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            [Environment]::SetEnvironmentVariable($name, $value, 'Process')
        }
    }
}

function Initialize-SelineRuntimeDirectory {
    New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
}

function Start-SelineForeground {
    Import-SelineEnvironment
    Set-Location -LiteralPath $repositoryRoot
    Write-Host 'Seline CLI is running in this terminal. Type stop or close this window to shut down Seline.' -ForegroundColor Cyan
    & npm.cmd run start --workspace=@anime/discord-bot

    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        Write-Host ''
        Write-Host "Seline failed to start or stopped with exit code $exitCode." -ForegroundColor Red
        Write-Host 'Review the error output above.' -ForegroundColor Yellow

        if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
            [void](Read-Host 'Press Enter to close this window')
        }

        exit $exitCode
    }
}

function Watch-SelineLogs {
    param([switch]$NewOnly)

    Initialize-SelineRuntimeDirectory
    if (-not (Test-Path -LiteralPath $standardOutputLog)) {
        New-Item -ItemType File -Path $standardOutputLog -Force | Out-Null
    }

    Write-Host 'Streaming Seline logs. Press Ctrl+C to stop viewing; Seline keeps running.' -ForegroundColor Cyan
    if ($NewOnly) {
        Get-Content -LiteralPath $standardOutputLog -Tail 0 -Wait
        return
    }

    Get-Content -LiteralPath $standardOutputLog -Tail 100 -Wait
}

$runningBot = Get-SelineProcesses
if ($Action -ieq 'logs') {
    Watch-SelineLogs
    return
}

if ($Action -ieq 'stop') {
    if (-not $runningBot) {
        Write-Host 'Seline is not running.' -ForegroundColor Yellow
        return
    }

    Write-Host "Stopping Seline (Node process: $($runningBot.ProcessId -join ', '))..." -ForegroundColor Yellow
    Stop-SelineProcesses -Processes $runningBot
    Write-Host 'Seline stopped.' -ForegroundColor Cyan
    return
}

if ($runningBot) {
    Write-Host "Stopping the existing Seline instance (Node process: $($runningBot.ProcessId -join ', '))..." -ForegroundColor Yellow
    Stop-SelineProcesses -Processes $runningBot
    $runningBot = @()
}

Start-SelineForeground
