<#
.SYNOPSIS
  Records what the machine's network is doing while `pnpm tauri:dev` runs, so a
  connection drop can be traced to a process instead of guessed at.

.DESCRIPTION
  Every 10 seconds appends one block to the log: a ping to the default gateway
  and to 1.1.1.1, the number of established / time-wait TCP connections, the
  top processes by open connections, and the DNS client cache size. Run it in
  its own terminal BEFORE starting the dev server, leave it running until the
  connection drops, then read the last few blocks before the drop.

  Nothing is sent anywhere; the log is local.

.EXAMPLE
  pwsh scripts/net-watch.ps1
  pwsh scripts/net-watch.ps1 -IntervalSeconds 5 -Log "$env:TEMP\aurora-net.log"
#>
param(
  [int]$IntervalSeconds = 10,
  [string]$Log = (Join-Path $env:LOCALAPPDATA "AuroraIDE\logs\net-watch.log")
)

$gateway = (Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue |
  Sort-Object RouteMetric | Select-Object -First 1).NextHop
Write-Host "Logging to $Log every $IntervalSeconds s. Gateway: $gateway. Ctrl+C to stop."

function Ping-Ms([string]$target) {
  if (-not $target) { return "n/a" }
  try {
    $r = Test-Connection -TargetName $target -Count 1 -TimeoutSeconds 2 -ErrorAction Stop
    return "$([int]$r.Latency) ms"
  } catch { return "FAIL" }
}

while ($true) {
  $established = @(Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue)
  $timeWait = @(Get-NetTCPConnection -State TimeWait -ErrorAction SilentlyContinue)
  $synSent = @(Get-NetTCPConnection -State SynSent -ErrorAction SilentlyContinue)
  $top = $established | Group-Object OwningProcess | Sort-Object Count -Descending | Select-Object -First 6 |
    ForEach-Object {
      $p = Get-Process -Id $_.Name -ErrorAction SilentlyContinue
      "    {0,4}  {1} (pid {2})" -f $_.Count, ($p.ProcessName ?? "?"), $_.Name
    }
  $dns = @(Get-DnsClientCache -ErrorAction SilentlyContinue).Count
  $udp = @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue).Count
  $adapter = Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object Status -eq "Up" |
    Select-Object -First 1 | ForEach-Object { "$($_.Name) $($_.LinkSpeed)" }

  $block = @(
    "[$(Get-Date -Format 'HH:mm:ss')] gateway=$(Ping-Ms $gateway) internet=$(Ping-Ms '1.1.1.1') adapter=$adapter",
    "  tcp established=$($established.Count) time-wait=$($timeWait.Count) syn-sent=$($synSent.Count) udp-endpoints=$udp dns-cache=$dns"
  ) + $top
  $block -join "`n" | Add-Content -Path $Log
  Write-Host ($block[0])
  Start-Sleep -Seconds $IntervalSeconds
}
