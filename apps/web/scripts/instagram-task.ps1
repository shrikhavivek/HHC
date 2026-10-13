param([switch]$Queued)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction Stop).Source
$collector = Join-Path $PSScriptRoot 'instagram-daily.mjs'
$arguments = '"' + $collector + '"'
if ($Queued) { $arguments += ' --queued' }
$process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory (Split-Path $PSScriptRoot -Parent) -WindowStyle Hidden -Wait -PassThru
exit $process.ExitCode
