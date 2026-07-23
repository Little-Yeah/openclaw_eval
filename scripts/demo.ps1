param(
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"

$demoRoot = Split-Path -Parent $PSScriptRoot
$apiDir = Join-Path $demoRoot "apps\api"
$webDir = Join-Path $demoRoot "apps\web"
$apiPython = Join-Path $apiDir ".venv\Scripts\python.exe"
$apiHealthUrl = "http://127.0.0.1:8000/api/health"
$webUrl = "http://127.0.0.1:5173"
$apiProcess = $null
$webProcess = $null

function Wait-ForUrl {
    param(
        [string]$Url,
        [string]$ServiceName,
        [int]$Retries = 60
    )

    for ($i = 0; $i -lt $Retries; $i++) {
        try {
            Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2 | Out-Null
            return
        } catch {
            Start-Sleep -Seconds 1
        }
    }

    throw "Timed out waiting for $ServiceName at $Url"
}

function Stop-DemoProcesses {
    foreach ($proc in @($apiProcess, $webProcess)) {
        if ($null -ne $proc -and -not $proc.HasExited) {
            taskkill /PID $proc.Id /T /F | Out-Null
        }
    }
}

try {
    if (-not (Test-Path $apiPython)) {
        throw "Missing API virtualenv python: $apiPython"
    }

    if (-not (Test-Path (Join-Path $webDir "node_modules"))) {
        Write-Host "Installing web dependencies..."
        npm install --prefix $webDir
    }

    $pythonPath = @(
        (Join-Path $demoRoot "apps\api\src")
        (Join-Path $demoRoot "apps\agent\src")
        (Join-Path $demoRoot "apps\router\src")
    ) -join ";"

    Write-Host "Starting API on http://127.0.0.1:8000"
    $apiCommand = @"
`$env:PYTHONPATH = '$pythonPath'
Set-Location '$apiDir'
& '$apiPython' -c "from pinch_api.app import main; main()"
"@
    $apiProcess = Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoExit", "-Command", $apiCommand) -PassThru

    Write-Host "Starting web app on http://127.0.0.1:5173"
    $webCommand = @"
Set-Location '$webDir'
npm run dev -- --host 127.0.0.1 --port 5173
"@
    $webProcess = Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoExit", "-Command", $webCommand) -PassThru

    Wait-ForUrl -Url $apiHealthUrl -ServiceName "API"
    Wait-ForUrl -Url $webUrl -ServiceName "web app"

    Write-Host ""
    Write-Host "Pinch Router Lab is ready: $webUrl"
    Write-Host "Two PowerShell windows were opened for API and web logs."
    Write-Host "Close this window or press Ctrl+C to stop both services."

    if (-not $NoBrowser) {
        Start-Process $webUrl | Out-Null
    }

    while ($true) {
        Start-Sleep -Seconds 2
        if ($apiProcess.HasExited) {
            throw "API process exited unexpectedly."
        }
        if ($webProcess.HasExited) {
            throw "Web process exited unexpectedly."
        }
    }
} finally {
    Stop-DemoProcesses
}
