# Closed-loop capacity: fixed 1600 VUs per run, so achieved RPS is the real ceiling (no maxVUs artefact).
param(
  [object]$Instances = @(1, 2, 3),
  [int]$Seconds = 45,
  [int]$WarmupSeconds = 60,
  [int]$VUs = 1600
)
$ErrorActionPreference = "Continue"
$Instances = @(@($Instances) | ForEach-Object { "$_" -split "," } | ForEach-Object { [int]$_.Trim() })
if ($Instances.Count -eq 0 -or ($Instances | Where-Object { $_ -lt 1 -or $_ -gt 6 })) {
  throw "Instances must be 1..6, got: $($Instances -join ',')"
}
Set-Location (Join-Path $PSScriptRoot '../..')
$out = "tests\performance\out"
New-Item -ItemType Directory -Force $out | Out-Null
$compose = @("-f", "docker-compose.yml", "-f", "deploy/docker-compose.scale.yml")
$env:CONSUMER_AUTO_STARTUP = "false"

function Compose { & docker compose @compose @args }
function AppIds { @(& docker compose @compose ps -q app) }
function Wait-Health {
  for ($i = 0; $i -lt 180; $i++) {
    try { $h = Invoke-RestMethod "http://localhost:8080/actuator/health" -TimeoutSec 2; if ($h.status -eq "UP") { return } } catch {}
    Start-Sleep 2
  }
  throw "app did not become healthy"
}
function Wait-Started($n) {
  for ($i = 0; $i -lt 120; $i++) {
    $ids = AppIds
    if ($ids.Count -eq $n) {
      $started = 0
      foreach ($id in $ids) { if ((& docker logs $id 2>&1) -match "Started CouponApplication") { $started++ } }
      if ($started -eq $n) { Start-Sleep 8; return }
    }
    Start-Sleep 2
  }
  throw "expected $n started app containers, got $(AppIds.Count)"
}
function Run-Capacity($name, $seconds) {
  $a = @("compose") + $compose + @("run", "--rm",
    "-e", "COUPON_ID=$script:coupon", "-e", "NAME=$name", "-e", "USER_OFFSET=$script:offset",
    "-e", "MODE=redis", "-e", "VUS=$VUs", "-e", "DURATION=${seconds}s",
    "k6", "run", "--quiet", "/scripts/capacity.js")
  $p = Start-Process docker -ArgumentList $a -NoNewWindow -PassThru `
    -RedirectStandardOutput "$out\k6_$name.log" -RedirectStandardError "$out\k6_${name}_err.log"
  $samples = @()
  while (-not $p.HasExited) {
    $line = docker stats --no-stream --format "{{.Name}}|{{.CPUPerc}}"
    foreach ($l in $line) {
      $parts = $l -split '\|'
      if ($parts.Count -ge 2) {
        $samples += [pscustomobject]@{ name = $parts[0]; cpu = [double](($parts[1] -replace '%', '') -replace ',', '.') / 100 }
      }
    }
    Start-Sleep -Milliseconds 1200
  }
  $p.WaitForExit()
  $j = Get-Content "results\$name.json" -Raw | ConvertFrom-Json
  Move-Item "results\$name.json" "$out\$name.json" -Force
  $app = $samples | Where-Object { $_.name -match "-app-\d+$" }
  $appCpu = if ($app) { [math]::Round((($app | Group-Object name | ForEach-Object { ($_.Group | Measure-Object cpu -Average).Average }) | Measure-Object -Sum).Sum, 2) } else { 0 }
  $redis = $samples | Where-Object { $_.name -match "-redis-1$" }
  $redisCpu = if ($redis) { [math]::Round(($redis | Measure-Object cpu -Average).Average, 2) } else { 0 }
  $nginx = $samples | Where-Object { $_.name -match "-nginx-1$" }
  $nginxCpu = if ($nginx) { [math]::Round(($nginx | Measure-Object cpu -Average).Average, 2) } else { 0 }
  $k6 = $samples | Where-Object { $_.name -match "-k6-run-" }
  $k6Cpu = if ($k6) { [math]::Round(($k6 | Measure-Object cpu -Average).Average, 2) } else { 0 }
  return [pscustomobject]@{
    name = $name
    achieved = [math]::Round($j.metrics.http_reqs.values.rate, 0)
    reqs = $j.metrics.http_reqs.values.count
    med = [math]::Round($j.metrics.http_req_duration.values.med, 1)
    p95 = [math]::Round($j.metrics.http_req_duration.values."p(95)", 1)
    p99 = [math]::Round($j.metrics.http_req_duration.values."p(99)", 1)
    failed = [math]::Round($j.metrics.http_req_failed.values.rate * 100, 2)
    appCpu = $appCpu
    redisCpu = $redisCpu
    nginxCpu = $nginxCpu
    k6Cpu = $k6Cpu
  }
}

Write-Host "== resetting the stack"
Compose down -v 2>&1 | Out-Null
Compose up -d --build --scale app=1 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { throw "compose up failed" }
Wait-Health
$script:coupon = (Invoke-RestMethod -Method Post "http://localhost:8080/api/coupons" -ContentType "application/json" `
    -Body (@{ name = "capacity"; stock = 100000000 } | ConvertTo-Json)).id
Invoke-RestMethod -Method Post "http://localhost:8080/api/coupons/$($script:coupon)/issue" | Out-Null
$script:offset = 0
$rows = @()
foreach ($n in $Instances) {
  if ((AppIds).Count -ne $n) {
    Write-Host "== scaling app to $n"
    Compose up -d --scale app=$n 2>&1 | Out-Null
  }
  Wait-Started $n
  Wait-Health
  $script:offset += 10000000
  Write-Host "== warm-up $n replica(s) ($WarmupSeconds s at $VUs VUs)"
  Run-Capacity "cap_${n}_warm" $WarmupSeconds | Out-Null
  Start-Sleep 3
  $script:offset += 10000000
  Write-Host "== capacity $n replica(s), $VUs VUs, $Seconds s"
  $r = Run-Capacity "cap_$n" $Seconds
  $r | Add-Member -NotePropertyName instances -NotePropertyValue $n
  $rows += $r
  Write-Host ("   {0:N0} rps, p95 {1} ms, app {2} cores total ({3}/instance), redis {4}" -f `
    $r.achieved, $r.p95, $r.appCpu, [math]::Round($r.appCpu / $n, 2), $r.redisCpu)
  Start-Sleep 3
}
$rows | Export-Csv "$out\capacity.csv" -NoTypeInformation -Encoding UTF8
$base = ($rows | Where-Object instances -eq $Instances[0]).achieved
$md = @("# Closed-loop capacity (constant $VUs VUs, app 2 vCPU per replica, consumer stopped)", "",
  "- Each VU sends the next claim when the previous one returns; throughput is the ceiling, not a maxVUs artefact.",
  "- Latency is queue-inclusive (closed loop stays saturated), so use it for the scaling ratio, not as a service-time SLO.",
  "", "| Instances | Achieved RPS | vs 1 replica | Requests | Median ms | p95 ms | p99 ms | Failed | app cores total | app cores/instance | redis cores | nginx cores | k6 cores |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|")
foreach ($r in $rows) {
  $md += "| $($r.instances) | $($r.achieved) | $([math]::Round($r.achieved / $base, 2))x | $($r.reqs) | $($r.med) | $($r.p95) | $($r.p99) | $($r.failed)% | $($r.appCpu) | $([math]::Round($r.appCpu / $r.instances, 2)) | $($r.redisCpu) | $($r.nginxCpu) | $($r.k6Cpu) |"
}
$md | Set-Content "$out\capacity.md" -Encoding UTF8
Write-Host "== wrote $out\capacity.md"
