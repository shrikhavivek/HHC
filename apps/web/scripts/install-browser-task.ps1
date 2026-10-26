$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction Stop).Source
$launcher = Join-Path $PSScriptRoot 'browser-task.vbs'
$arguments = '//B //Nologo "' + $launcher + '" "' + $node + '"'
$action = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\wscript.exe') -Argument $arguments -WorkingDirectory (Split-Path $PSScriptRoot -Parent)
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$logon = New-ScheduledTaskTrigger -AtLogOn -User $principal.UserId
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
# Retire the old request-only launcher so two collectors cannot claim the same profile.
$legacy = Get-ScheduledTask -TaskName 'HHC Instagram Requests' -ErrorAction SilentlyContinue
if ($legacy) {
    Stop-ScheduledTask -TaskName $legacy.TaskName
    Disable-ScheduledTask -TaskName $legacy.TaskName | Out-Null
    Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match '[\\/]instagram-requests\.mjs(?:"|\s|$)' } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
}
Register-ScheduledTask -TaskName 'HHC Browser Requests' -Action $action -Trigger @($trigger, $logon) -Principal $principal -Settings $settings -Description 'Opens Instagram or Reddit only when an editor requests collection in HHC.' -Force | Select-Object TaskName, State
Start-ScheduledTask -TaskName 'HHC Browser Requests'
