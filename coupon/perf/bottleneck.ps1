# Step 0: where does the single-machine stack actually saturate?
# Runs the unmodified redis path at several fixed arrival rates and samples `docker stats`
# during each run. Writes CSV samples + a markdown summary under perf\out\.
param(
  [int[]]$Rates = @(6000, 12000, 20000),
  [int]$Seconds = 30
)
$ErrorActionPreference = "Continue"
Set-Location (Split-Path $PSScriptRoot -Parent)
$out = "perf\out"
New-Item -ItemType Directory -Force $out | Out-Null

function Wait-App {
  for ($i = 0; $i -lt 120; $i++) {
    try { $h = Invoke-RestMethod "http://localhost:8080/actuator/health" -TimeoutSec 3; if ($h.status -eq "UP") { Start-Sleep 8; return } } catch {}
    Start-Sleep 3
  }
  throw "app did not become healthy"
}
function Get-Stats($id) { Invoke-RestMethod "http://localhost:8080/api/coupons/$id/stats" }
function Wait-Persisted($id, $maxSeconds) {
  $t0 = Get-Date
  while (((Get-Date) - $t0).TotalSeconds -lt $maxSeconds) {
    $s = Get-Stats $id
    if ($s.dbClaims -ge $s.redisClaimed) { return $true }
    Start-Sleep 2
  }
  return $false
}

Write-Host "== starting stack (consumer batch mode for faster catch-up between runs)"
$env:CONSUMER_BATCH = "true"
docker compose up -d --build | Out-Host
if ($LASTEXITCODE -ne 0) { throw "compose up failed" }
Wait-App

Write-Host "== creating one high-stock coupon"
$body = @{ name = "bottleneck"; stock = 100000000 } | ConvertTo-Json
$coupon = Invoke-RestMethod -Method Post "http://localhost:8080/api/coupons" -ContentType "application/json" -Body $body
$id = $coupon.id
Invoke-RestMethod -Method Post "http://localhost:8080/api/coupons/$id/issue" | Out-Null
Write-Host "coupon id = $id"

$summary = @()
$offset = 0
foreach ($rate in $Rates) {
  $offset += 50000000
  $name = "base_$rate"
  Write-Host "== rate $rate rps for $Seconds s"
  $args = @("compose", "run", "--rm",
    "-e", "BASE=http://app:8080", "-e", "COUPON_ID=$id", "-e", "RATE=$rate",
    "-e", "DURATION=${Seconds}s", "-e", "NAME=$name", "-e", "USER_OFFSET=$offset",
    "-e", "MODE=redis", "k6", "run", "--quiet", "/scripts/throughput.js")
  $p = Start-Process docker -ArgumentList $args -NoNewWindow -PassThru `
    -RedirectStandardOutput "$out\k6_$rate.log" -RedirectStandardError "$out\k6_${rate}_err.log"
  $samples = @()
  $t0 = Get-Date
  while (-not $p.HasExited) {
    $line = docker stats --no-stream --format "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}"
    foreach ($l in $line) {
      $parts = $l -split '\|'
      if ($parts.Count -ge 3) {
        $samples += [pscustomobject]@{
          t = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
          name = $parts[0]
          # docker stats CPUPerc is percent of ONE core (100% = 1 core), so divide by 100.
          cpu = [double](($parts[1] -replace '%', '') -replace ',', '.') / 100
          mem = $parts[2]
        }
      }
    }
    Start-Sleep -Milliseconds 1500
  }
  $p.WaitForExit()
  $samples | Export-Csv "$out\stats_$rate.csv" -NoTypeInformation -Encoding UTF8

  $j = Get-Content "results\$name.json" -Raw | ConvertFrom-Json
  $achieved = $j.metrics.http_reqs.values.rate
  $p95 = $j.metrics.http_req_duration.values.'p(95)'
  $p99 = $j.metrics.http_req_duration.values.'p(99)'
  $med = $j.metrics.http_req_duration.values.med
  $reqs = $j.metrics.http_reqs.values.count
  $dropped = if ($j.metrics.dropped_iterations) { $j.metrics.dropped_iterations.values.count } else { 0 }
  $failed = $j.metrics.http_req_failed.values.rate

  $by = $samples | Group-Object name | ForEach-Object {
    [pscustomobject]@{
      name = $_.Name
      cpuAvg = [math]::Round(($_.Group | Measure-Object cpu -Average).Average, 1)
      cpuMax = [math]::Round(($_.Group | Measure-Object cpu -Maximum).Maximum, 1)
    }
  }
  $appCpu = ($by | Where-Object name -like "*app*" | Select-Object -First 1).cpuAvg
  $redisCpu = ($by | Where-Object name -like "*redis*" | Select-Object -First 1).cpuAvg
  $kafkaCpu = ($by | Where-Object name -like "*kafka*" | Select-Object -First 1).cpuAvg
  $k6Cpu = ($by | Where-Object name -like "*k6*" | Select-Object -First 1).cpuAvg
  $pgCpu = ($by | Where-Object name -like "*postgres*" | Select-Object -First 1).cpuAvg
  $summary += [pscustomobject]@{
    rate = $rate; achieved = [math]::Round($achieved, 0); reqs = $reqs; dropped = $dropped
    med = [math]::Round($med, 1); p95 = [math]::Round($p95, 1); p99 = [math]::Round($p99, 1)
    failedPct = [math]::Round($failed * 100, 2)
    appCpu = $appCpu; redisCpu = $redisCpu; kafkaCpu = $kafkaCpu; k6Cpu = $k6Cpu; pgCpu = $pgCpu
  }
  Write-Host ("   achieved {0:N0} rps, p95 {1} ms, app {2} cores, redis {3} cores, kafka {4}, k6 {5}" -f `
    $achieved, [math]::Round($p95,1), $appCpu, $redisCpu, $kafkaCpu, $k6Cpu)

  Write-Host "== waiting for consumer to catch up"
  $ok = Wait-Persisted $id 600
  if (-not $ok) { Write-Host "   WARNING: consumer still behind after 600 s" }
}
$summary | Export-Csv "$out\bottleneck.csv" -NoTypeInformation -Encoding UTF8
$summary | Format-Table -AutoSize | Out-Host

$md = @("# Bottleneck probe (single instance, no CPU limits)", "",
  "Rates: $($Rates -join ', ') rps, ${Seconds}s each. CPU in cores (100% = 1 core).", "",
  "| Target RPS | Achieved RPS | Requests | Dropped | Median ms | p95 ms | p99 ms | Failed | app cores | redis cores | kafka cores | k6 cores | pg cores |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|")
foreach ($s in $summary) {
  $md += "| $($s.rate) | $($s.achieved) | $($s.reqs) | $($s.dropped) | $($s.med) | $($s.p95) | $($s.p99) | $($s.failedPct)% | $($s.appCpu) | $($s.redisCpu) | $($s.kafkaCpu) | $($s.k6Cpu) | $($s.pgCpu) |"
}
$md | Set-Content "$out\bottleneck.md" -Encoding UTF8
Write-Host "== wrote $out\bottleneck.md"
