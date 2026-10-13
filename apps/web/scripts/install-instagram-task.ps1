$ErrorActionPreference = 'Stop'
if ((Get-TimeZone).Id -ne 'India Standard Time') { throw 'Set Windows timezone to India Standard Time before installing this 09:00 daily task.' }
$node = (Get-Command node -ErrorAction Stop).Source
$collector = Join-Path $PSScriptRoot 'instagram-daily.mjs'
if (-not (Test-Path -LiteralPath $collector -PathType Leaf)) { throw 'Collector script not found.' }
$launcher = Join-Path $PSScriptRoot 'instagram-task.ps1'
$powershell = Join-Path $PSHOME 'powershell.exe'
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $launcher + '"'
$action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory (Split-Path $PSScriptRoot -Parent)
$trigger = New-ScheduledTaskTrigger -Daily -At '09:00'
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 90)
Register-ScheduledTask -TaskName 'HHC Instagram Daily' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Daily 09:00 IST local Instagram watchlist scan. Requires Windows sign-in, Docker app and a valid browser session. Stops on access restrictions.' -Force | Select-Object TaskName, State
$requestAction = New-ScheduledTaskAction -Execute $powershell -Argument ($arguments + ' -Queued') -WorkingDirectory (Split-Path $PSScriptRoot -Parent)
$requestTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'HHC Instagram Requests' -Action $requestAction -Trigger $requestTrigger -Principal $principal -Settings $settings -Description 'Checks for an authenticated HHC Scan now request each minute. Opens Instagram only for a queued scan.' -Force | Select-Object TaskName, State
