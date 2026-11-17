# Horizontal-scaling curve: 1 -> 2 -> 3 app replicas behind nginx, each capped at 2 vCPUs.
# Consumer listeners are stopped so the measurement isolates the synchronous claim path.
# Usage: powershell -ExecutionPolicy Bypass -File perf\scale_test.ps1
param(
  [object]$Instances = @(1, 2, 3),
  [int]$Seconds = 45,
  [int]$Rate = 20000,
  [int]$Repeats = 2
)
$ErrorActionPreference = "Continue"
# `powershell -File script.ps1 -Instances 1,2,3` binds the whole string "1,2,3" to one element,
# so normalise from any of: 1,2,3 / "1,2,3" / @(1,2,3).
$Instances = @(@($Instances) | ForEach-Object { "$_" -split "," } | ForEach-Object { [int]$_.Trim() })
if ($Instances.Count -eq 0 -or ($Instances | Where-Object { $_ -lt 1 -or $_ -gt 6 })) {
  throw "Instances must be 1..6, got: $($Instances -join ',')"
}
Set-Location (Split-Path $PSScriptRoot -Parent)
$out = "perf\out"
New-Item -ItemType Directory -Force $out | Out-Null
$compose = @("-f", "docker-compose.yml", "-f", "docker-compose.scale.yml")
$env:CONSUMER_AUTO_STARTUP = "false"

function Compose { & docker compose @compose @args }
function AppIds { @(& docker compose @compose ps -q app) }
function Wait-Health {
  for ($i = 0; $i -lt 180; $i++) {
    try { $h = Invoke-RestMethod "http://localhost:8080/actuator/health" -TimeoutSec 2; if ($h.status -eq "UP") { return } } catch {}
    Start-Sleep 2
  }
  throw "app did not become healthy behind nginx"
}
function Wait-Started($n) {
  for ($i = 0; $i -lt 120; $i++) {
    $ids = AppIds
    if ($ids.Count -eq $n) {
      $started = 0
      foreach ($id in $ids) {
        $log = & docker logs $id 2>&1
        if ($log -match "Started CouponApplication") { $started++ }
      }
      if ($started -eq $n) { Start-Sleep 8; return }
    }
    Start-Sleep 2
  }
  throw "expected $n started app containers, got $(AppIds.Count)"
}
function Run-K6($name, $rate, $seconds) {
  $a = @("compose") + $compose + @("run", "--rm",
    "-e", "COUPON_ID=$script:coupon", "-e", "RATE=$rate", "-e", "DURATION=${seconds}s",
    "-e", "NAME=$name", "-e", "USER_OFFSET=$script:offset", "-e", "MODE=redis",
    "-e", "VUS=2000", "-e", "MAXVUS=10000", "k6", "run", "--quiet", "/scripts/throughput.js")
  $p = Start-Process docker -ArgumentList $a -NoNewWindow -PassThru `
    -RedirectStandardOutput "$out\k6_$name.log" -RedirectStandardError "$out\k6_${name}_err.log"
  $samples = @()
  while (-not $p.HasExited) {
    $line = docker stats --no-stream --format "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}"
    foreach ($l in $line) {
      $parts = $l -split '\|'
      if ($parts.Count -ge 3) {
        $samples += [pscustomobject]@{
          name = $parts[0]
          cpu = [double](($parts[1] -replace '%', '') -replace ',', '.') / 100
          mem = $parts[2]
        }
      }
    }
    Start-Sleep -Milliseconds 1200
  }
  $p.WaitForExit()
  $samples | Export-Csv "$out\stats_$name.csv" -NoTypeInformation -Encoding UTF8
  $j = Get-Content "results\$name.json" -Raw | ConvertFrom-Json
  Move-Item "results\$name.json" "$out\$name.json" -Force
  $app = $samples | Where-Object { $_.name -match "-app-\d+$" }
  $appTotal = if ($app) { [math]::Round((($app | Group-Object name | ForEach-Object {
      ($_.Group | Measure-Object cpu -Average).Average
    }) | Measure-Object -Sum).Sum, 2) } else { 0 }
  $others = @{}
  foreach ($svc in @("redis", "kafka", "nginx", "postgres")) {
    $g = $samples | Where-Object { $_.name -match "-$svc-1$" }
    $others[$svc] = if ($g) { [math]::Round((($g | Measure-Object cpu -Average).Average), 2) } else { 0 }
  }
  $k6g = $samples | Where-Object { $_.name -match "-k6-run-" }
  $k6cpu = if ($k6g) { [math]::Round((($k6g | Measure-Object cpu -Average).Average), 2) } else { 0 }
  return [pscustomobject]@{
    name = $name
    achieved = [math]::Round($j.metrics.http_reqs.values.rate, 0)
    reqs = $j.metrics.http_reqs.values.count
    dropped = if ($j.metrics.dropped_iterations) { $j.metrics.dropped_iterations.values.count } else { 0 }
    med = [math]::Round($j.metrics.http_req_duration.values.med, 1)
    p95 = [math]::Round($j.metrics.http_req_duration.values."p(95)", 1)
    p99 = [math]::Round($j.metrics.http_req_duration.values."p(99)", 1)
    failed = [math]::Round($j.metrics.http_req_failed.values.rate * 100, 2)
    appCpu = $appTotal
    appPerInstance = if ($Instances -gt 0) { [math]::Round($appTotal / $script:currentN, 2) } else { 0 }
    redisCpu = $others["redis"]; kafkaCpu = $others["kafka"]; nginxCpu = $others["nginx"]
    k6Cpu = $k6cpu
  }
}

Write-Host "== resetting the stack"
Compose down -v | Out-Null
Compose up -d --build --scale app=1 | Out-Host
if ($LASTEXITCODE -ne 0) { throw "compose up failed" }
Wait-Health
$script:coupon = (Invoke-RestMethod -Method Post "http://localhost:8080/api/coupons" -ContentType "application/json" `
    -Body (@{ name = "scale"; stock = 100000000 } | ConvertTo-Json)).id
Invoke-RestMethod -Method Post "http://localhost:8080/api/coupons/$($script:coupon)/issue" | Out-Null
Write-Host "coupon = $($script:coupon)"

$rows = @()
$script:offset = 0
$script:currentN = 0
foreach ($n in $Instances) {
  if ((AppIds).Count -ne $n) {
    Write-Host "== scaling app to $n replica(s)"
    Compose up -d --scale app=$n | Out-Host
  }
  $script:currentN = $n
  Wait-Started $n
  Wait-Health

  $script:offset += 10000000
  Write-Host "== warm-up ($n replica(s))"
  Run-K6 "scale_${n}_warm" 3000 10 | Out-Null
  Start-Sleep 2

  for ($rep = 1; $rep -le $Repeats; $rep++) {
    $script:offset += 10000000
    $name = "scale_${n}_$rep"
    Write-Host "== $n replica(s), repeat $rep, target $Rate rps for $Seconds s"
    $r = Run-K6 $name $Rate $Seconds
    $r | Add-Member -NotePropertyName instances -NotePropertyValue $n
    $rows += $r
    Write-Host ("   achieved {0:N0} rps, p95 {1} ms, app {2} cores total ({3}/instance), redis {4}" -f `
      $r.achieved, $r.p95, $r.appCpu, $r.appPerInstance, $r.redisCpu)
    Start-Sleep 3
  }
}

$rows | Export-Csv "$out\scale.csv" -NoTypeInformation -Encoding UTF8
$md = @("# Horizontal scaling behind nginx (app capped at 2 vCPU per replica)", "",
  "- Load: constant arrival rate $Rate rps, ${Seconds}s per run, $Repeats repeats; consumer listeners stopped.",
  "- k6 and the whole stack share one machine, so k6 is also a tenant; its CPU is reported below.",
  "- Values are per run; the table in the README uses the median of the repeats.", "",
  "| Instances | Repeat | Achieved RPS | Requests | Dropped | Median ms | p95 ms | p99 ms | Failed | app cores total | app cores/instance | redis cores | kafka cores | nginx cores | k6 cores |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
foreach ($r in $rows) {
  $md += "| $($r.instances) | $($r.name.Split('_')[-1]) | $($r.achieved) | $($r.reqs) | $($r.dropped) | $($r.med) | $($r.p95) | $($r.p99) | $($r.failed)% | $($r.appCpu) | $($r.appPerInstance) | $($r.redisCpu) | $($r.kafkaCpu) | $($r.nginxCpu) | $($r.k6Cpu) |"
}
$md | Set-Content "$out\scale.md" -Encoding UTF8
Write-Host "== wrote $out\scale.md"
