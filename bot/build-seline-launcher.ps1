$ErrorActionPreference = 'Stop'

$directory = Split-Path -Parent $PSCommandPath
$compiler = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$icon = Join-Path $directory 'assets\Saline\seline-face.ico'
$source = Join-Path $directory 'SelineLauncher.cs'
$output = Join-Path $directory 'Seline.exe'

if (-not (Test-Path -LiteralPath $compiler)) { throw "C# compiler not found: $compiler" }
if (-not (Test-Path -LiteralPath $icon)) { throw "Launcher icon not found: $icon" }

& $compiler /nologo /target:winexe /out:$output /win32icon:$icon /r:System.Windows.Forms.dll $source
if ($LASTEXITCODE -ne 0) { throw "Seline launcher build failed with exit code $LASTEXITCODE." }
