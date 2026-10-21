param([switch]$RequestsOnly)
$ErrorActionPreference = 'Stop'
if (-not $RequestsOnly -and (Get-TimeZone).Id -ne 'India Standard Time') { throw 'Set Windows timezone to India Standard Time before installing this 09:00 daily task.' }
$node = (Get-Command node -ErrorAction Stop).Source
$collector = Join-Path $PSScriptRoot 'instagram-daily.mjs'
if (-not (Test-Path -LiteralPath $collector -PathType Leaf)) { throw 'Collector script not found.' }
$launcher = Join-Path $PSScriptRoot 'instagram-task.vbs'
$scriptHost = Join-Path $env:WINDIR 'System32\wscript.exe'
$arguments = '//B //Nologo "' + $launcher + '" "' + $node + '"'
$action = New-ScheduledTaskAction -Execute $scriptHost -Argument $arguments -WorkingDirectory (Split-Path $PSScriptRoot -Parent)
$trigger = New-ScheduledTaskTrigger -Daily -At '09:00'
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 90)
if (-not $RequestsOnly) {
    Register-ScheduledTask -TaskName 'HHC Instagram Daily' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Daily 09:00 IST local Instagram watchlist scan. Opens Instagram for sign-in when needed. Stops on access restrictions.' -Force | Select-Object TaskName, State
}
$requestAction = New-ScheduledTaskAction -Execute $scriptHost -Argument ($arguments + ' --queued') -WorkingDirectory (Split-Path $PSScriptRoot -Parent)
$requestTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $principal.UserId
$requestSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'HHC Instagram Requests' -Action $requestAction -Trigger @($requestTrigger, $logonTrigger) -Principal $principal -Settings $requestSettings -Description 'Checks local HHC scan requests every three seconds. Opens Instagram for sign-in and continues the queued scan after login.' -Force | Select-Object TaskName, State
Start-ScheduledTask -TaskName 'HHC Instagram Requests'
