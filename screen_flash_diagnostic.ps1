# Screen Flash / Display Blackout Diagnostic Collector
# Safe read-only diagnostic script.
# Run with PowerShell as Administrator for best results.
# It creates a text report on your Desktop and opens it in Notepad.

$ErrorActionPreference = "SilentlyContinue"

$Timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$Report = Join-Path $env:USERPROFILE ("Desktop\screen_flash_diagnostic_$Timestamp.txt")

function Add-Line {
    param([string]$Text = "")
    $Text | Out-File $Report -Append -Encoding UTF8
}

function Add-Section {
    param(
        [string]$Title,
        [scriptblock]$Command
    )

    Add-Line ""
    Add-Line "==================== $Title ===================="
    Add-Line ""

    try {
        & $Command | Out-String -Width 220 | Out-File $Report -Append -Encoding UTF8
    } catch {
        Add-Line "ERROR: $($_.Exception.Message)"
    }
}

function Short-Event {
    param($Event)

    $msg = ""
    if ($Event.Message) {
        $msg = ($Event.Message -replace "\s+", " ").Trim()
        if ($msg.Length -gt 900) {
            $msg = $msg.Substring(0, 900) + "..."
        }
    }

    [PSCustomObject]@{
        Time    = $Event.TimeCreated
        Level   = $Event.LevelDisplayName
        ID      = $Event.Id
        Source  = $Event.ProviderName
        Message = $msg
    }
}

"Screen flash / display blackout diagnostic report" | Out-File $Report -Encoding UTF8
Add-Line "Created: $(Get-Date)"
Add-Line "Computer: $env:COMPUTERNAME"
Add-Line "User: $env:USERNAME"
Add-Line "Script: read-only diagnostic collection"
Add-Line ""

Add-Section "Windows and system info" {
    Get-ComputerInfo |
    Select-Object OsName, OsVersion, WindowsVersion, OsBuildNumber, BiosManufacturer, BiosReleaseDate, CsManufacturer, CsModel, CsSystemType

    Get-CimInstance Win32_ComputerSystem |
    Select-Object Manufacturer, Model, SystemType, @{n="RAM_GB";e={[math]::Round($_.TotalPhysicalMemory / 1GB, 2)}}
}

Add-Section "GPU / display adapter info" {
    Get-CimInstance Win32_VideoController |
    Select-Object Name, VideoProcessor, DriverVersion, DriverDate, Status, AdapterCompatibility,
        @{n="AdapterRAM_GB";e={[math]::Round($_.AdapterRAM / 1GB, 2)}},
        CurrentHorizontalResolution, CurrentVerticalResolution, CurrentRefreshRate
}

Add-Section "Monitor and display devices" {
    Get-PnpDevice -Class Display,Monitor |
    Select-Object Class, FriendlyName, Manufacturer, Status, Problem |
    Format-Table -AutoSize
}

Add-Section "Device Manager problem devices" {
    Get-CimInstance Win32_PnPEntity |
    Where-Object { $_.ConfigManagerErrorCode -ne 0 } |
    Select-Object Name, PNPClass, Manufacturer, Status, ConfigManagerErrorCode |
    Format-Table -AutoSize
}

Add-Section "Power settings related to display" {
    powercfg /getactivescheme
    powercfg /query SCHEME_CURRENT SUB_VIDEO
    powercfg /requests
    powercfg /lastwake
}

Add-Section "Recent display / GPU / DWM related System events - last 14 days" {
    $start = (Get-Date).AddDays(-14)

    Get-WinEvent -FilterHashtable @{LogName="System"; StartTime=$start} -MaxEvents 4000 |
    Where-Object {
        $_.ProviderName -match "Display|nvlddmkm|amdkmdag|amdwddmg|igfx|Intel|WHEA|Kernel-Power|Kernel-General|DriverFrameworks|DisplayEnhancementService" -or
        $_.Message -match "display|graphics|video|monitor|screen|nvlddmkm|amdkmdag|igfx|driver stopped|driver recovered"
    } |
    Select-Object -First 100 |
    ForEach-Object { Short-Event $_ } |
    Format-Table -Wrap -AutoSize
}

Add-Section "Recent critical and error System events - last 7 days" {
    $start = (Get-Date).AddDays(-7)

    Get-WinEvent -FilterHashtable @{LogName="System"; StartTime=$start; Level=1,2} -MaxEvents 150 |
    ForEach-Object { Short-Event $_ } |
    Format-Table -Wrap -AutoSize
}

Add-Section "Recent Application crashes / Windows Error Reporting - last 14 days" {
    $start = (Get-Date).AddDays(-14)

    Get-WinEvent -FilterHashtable @{LogName="Application"; StartTime=$start} -MaxEvents 3000 |
    Where-Object {
        $_.ProviderName -match "Windows Error Reporting|Application Error|Application Hang|Desktop Window Manager|DWM" -or
        $_.Message -match "display|graphics|driver|dwm|nvlddmkm|amdkmdag|igfx|LiveKernelEvent"
    } |
    Select-Object -First 100 |
    ForEach-Object { Short-Event $_ } |
    Format-Table -Wrap -AutoSize
}

Add-Section "Reliability records mentioning hardware/display/crashes - last 30 days" {
    $start = (Get-Date).AddDays(-30)

    Get-CimInstance -Namespace root\cimv2 -ClassName Win32_ReliabilityRecords |
    Where-Object {
        $_.TimeGenerated -gt $start -and
        ($_.Message -match "hardware|display|video|graphics|driver|Windows stopped|shut down|crash|LiveKernelEvent|blue screen")
    } |
    Select-Object TimeGenerated, SourceName, ProductName, EventIdentifier, Message |
    Format-Table -Wrap -AutoSize
}

Add-Section "Last boot / shutdown / sleep / power-loss related events" {
    Get-WinEvent -FilterHashtable @{LogName="System"; Id=41,42,1074,6005,6006,6008,1} -MaxEvents 40 |
    ForEach-Object { Short-Event $_ } |
    Format-Table -Wrap -AutoSize
}

Add-Section "Installed display-related drivers" {
    Get-CimInstance Win32_PnPSignedDriver |
    Where-Object {
        $_.DeviceClass -match "DISPLAY|MONITOR" -or
        $_.DeviceName -match "NVIDIA|AMD|Radeon|Intel|Display|Graphics|Monitor"
    } |
    Select-Object DeviceName, DeviceClass, Manufacturer, DriverVersion, DriverDate, InfName, IsSigned |
    Sort-Object DeviceClass, DeviceName |
    Format-Table -Wrap -AutoSize
}

Add-Section "Current high refresh / HDR / variable refresh hints" {
    Add-Line "This section may be blank on some Windows versions."
    Get-ItemProperty "HKCU:\Software\Microsoft\DirectX\UserGpuPreferences" | Format-List
    Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\VideoSettings" | Format-List
}

Add-Line ""
Add-Line "==================== END OF REPORT ===================="
Add-Line ""
Add-Line "Next step: copy this whole report and send it to ChatGPT for analysis."

Write-Host ""
Write-Host "Diagnostic report created:"
Write-Host $Report
Write-Host ""
Write-Host "Opening report in Notepad..."
Start-Process notepad.exe $Report
