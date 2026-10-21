param([switch]$Queued)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction Stop).Source
$collector = Join-Path $PSScriptRoot 'instagram-daily.mjs'
if ($Queued) { $collector = Join-Path $PSScriptRoot 'instagram-requests.mjs' }
$arguments = '"' + $collector + '"'
$process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory (Split-Path $PSScriptRoot -Parent) -WindowStyle Hidden -Wait -PassThru
exit $process.ExitCode
