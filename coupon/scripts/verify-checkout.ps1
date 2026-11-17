param(
    [string]$ProjectPath = (Split-Path -Parent $PSScriptRoot),
    [string]$BaseUrl = 'http://127.0.0.1:8080'
)

$ErrorActionPreference = 'Stop'
$api = "$BaseUrl/api"
$userId = 102
$suffix = [guid]::NewGuid().ToString('N')
$faultName = "checkout_verify_$suffix"
$faultOrder = [guid]::NewGuid().ToString()
$cleanupFault = $false

function Assert-Check($Condition, [string]$Description) {
    if (-not $Condition) { throw "FAIL: $Description" }
}

function Invoke-TestSql([string]$Sql) {
    $result = $Sql | docker compose exec -T postgres psql -X -qAt -v ON_ERROR_STOP=1 -U coupon -d coupon
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL verification command failed.' }
    return ($result -join "`n").Trim()
}

function New-TestCoupon([string]$Name) {
    $offer = @{ name = "$Name $suffix"; stock = 5; minOrderAmount = 100; discountAmount = 20 } | ConvertTo-Json
    $coupon = Invoke-RestMethod -Method Post -Uri "$api/coupons" -ContentType 'application/json' -Body $offer
    $couponId = [long]$coupon.id
    Invoke-RestMethod -Method Post -Uri "$api/coupons/$couponId/issue" | Out-Null
    Invoke-RestMethod -Method Post -Uri "$api/coupons/$couponId/claim?userId=$userId" | Out-Null
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        $wallet = Invoke-RestMethod "$api/users/$userId/coupons"
        if ($wallet | Where-Object { $_.coupon.id -eq $couponId -and $_.status -eq 'AVAILABLE' }) {
            return $couponId
        }
        Start-Sleep -Milliseconds 500
    }
    throw "Coupon $couponId did not reach the wallet."
}

function Start-TestOrder([string]$OrderId, [long]$CouponId, [string]$ProductId = 'weekender-bag') {
    $body = @{ productId = $ProductId; couponId = $CouponId } | ConvertTo-Json -Compress
    $content = [System.Net.Http.StringContent]::new($body, [Text.Encoding]::UTF8, 'application/json')
    return $client.PostAsync("$api/checkout/users/$userId/orders/$OrderId", $content)
}

function Read-TestOrder($Task) {
    $response = $Task.GetAwaiter().GetResult()
    try {
        $raw = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        $body = $null
        if ($raw) {
            try { $body = ConvertFrom-Json -InputObject $raw } catch { $body = $raw }
        }
        return [pscustomobject]@{ Status = [int]$response.StatusCode; Body = $body }
    } finally {
        $response.Dispose()
    }
}

Push-Location -LiteralPath $ProjectPath
$client = $null
try {
    Add-Type -AssemblyName System.Net.Http
    $client = [System.Net.Http.HttpClient]::new()
    $client.Timeout = [TimeSpan]::FromSeconds(20)
    $health = Invoke-RestMethod "$BaseUrl/actuator/health" -TimeoutSec 5
    Assert-Check ($health.status -eq 'UP') 'backend is ready'
    Assert-Check ((Invoke-TestSql "SELECT to_regclass('checkout_order') IS NOT NULL;") -eq 't') 'checkout schema exists'

    $couponId = New-TestCoupon 'Checkout verification'
    $low = Invoke-RestMethod "$api/checkout/quote?userId=$userId&productId=canvas-tote&couponId=$couponId"
    $high = Invoke-RestMethod "$api/checkout/quote?userId=$userId&productId=weekender-bag&couponId=$couponId"
    Assert-Check ($low.result -eq 'BELOW_MIN_ORDER' -and $low.shortfallCents -eq 5000) '50 dollar order is rejected'
    Assert-Check ($high.result -eq 'ELIGIBLE' -and $high.subtotalCents -eq 12000 -and $high.discountCents -eq 2000 -and $high.totalCents -eq 10000) 'server quotes 120 minus 20 equals 100'
    Write-Host 'PASS 1/5: server pricing and order minimum'

    $orderId = [guid]::NewGuid().ToString()
    $first = Read-TestOrder (Start-TestOrder $orderId $couponId)
    $replay = Read-TestOrder (Start-TestOrder $orderId $couponId)
    Assert-Check ($first.Status -eq 200 -and $first.Body.pricing.totalCents -eq 10000 -and $replay.Status -eq 200) 'first order and retry both return 200'
    Assert-Check ($first.Body.orderId -eq $orderId -and $first.Body.pricing.result -eq 'REDEEMED' -and
        ($first.Body | ConvertTo-Json -Depth 6 -Compress) -ceq ($replay.Body | ConvertTo-Json -Depth 6 -Compress)) 'retry returns the original receipt'
    Write-Host 'PASS 2/5: same order returns the same receipt'

    $conflict = Read-TestOrder (Start-TestOrder $orderId $couponId 'canvas-tote')
    Assert-Check ($conflict.Status -eq 409 -and $conflict.Body.result -eq 'ORDER_CONFLICT') 'changed product conflicts with existing order'
    Write-Host 'PASS 3/5: changed order parameters return ORDER_CONFLICT'

    $raceCoupon = New-TestCoupon 'Concurrent checkout verification'
    $raceA = [guid]::NewGuid().ToString()
    $raceB = [guid]::NewGuid().ToString()
    $taskA = Start-TestOrder $raceA $raceCoupon
    $taskB = Start-TestOrder $raceB $raceCoupon
    $resultA = Read-TestOrder $taskA
    $resultB = Read-TestOrder $taskB
    $winner = @($resultA, $resultB) | Where-Object { $_.Status -eq 200 -and $_.Body.pricing.result -eq 'REDEEMED' -and $_.Body.pricing.totalCents -eq 10000 }
    $loser = @($resultA, $resultB) | Where-Object { $_.Status -eq 409 -and $_.Body.result -eq 'ALREADY_REDEEMED' }
    Assert-Check (@($winner).Count -eq 1 -and @($loser).Count -eq 1) 'exactly one concurrent order succeeds'
    $stored = Invoke-TestSql "SELECT order_id FROM checkout_order WHERE user_id = $userId AND order_id IN ('$raceA', '$raceB');"
    Assert-Check ($stored -eq $winner.Body.orderId) 'only the successful order persists'
    Assert-Check ((Invoke-TestSql "SELECT order_id FROM coupon_claim WHERE user_id = $userId AND coupon_id = $raceCoupon AND status = 'REDEEMED';") -eq "demo-$stored") 'claim references the winning order'
    Write-Host 'PASS 4/5: concurrent orders redeem once and persist one receipt'

    $faultCoupon = New-TestCoupon 'Rollback verification'
    $sql = @'
CREATE FUNCTION __NAME__() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.order_id = 'demo-__ORDER__' THEN
        RAISE EXCEPTION 'checkout verification rollback probe';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER __NAME__ AFTER UPDATE ON coupon_claim
    FOR EACH ROW WHEN (NEW.order_id = 'demo-__ORDER__')
    EXECUTE FUNCTION __NAME__();
'@
    $cleanupFault = $true
    Invoke-TestSql ($sql.Replace('__NAME__', $faultName).Replace('__ORDER__', $faultOrder)) | Out-Null
    $failure = Read-TestOrder (Start-TestOrder $faultOrder $faultCoupon)
    Assert-Check ($failure.Status -eq 500) 'injected database failure is surfaced'
    $persisted = Invoke-TestSql "SELECT count(*) FROM checkout_order WHERE user_id = $userId AND order_id = '$faultOrder';"
    $claimState = Invoke-TestSql "SELECT status || '|' || COALESCE(order_id, '') FROM coupon_claim WHERE user_id = $userId AND coupon_id = $faultCoupon;"
    Assert-Check ($persisted -eq '0' -and $claimState -eq 'CLAIMED|') 'both receipt and redemption roll back'

    Invoke-TestSql "DROP TRIGGER IF EXISTS $faultName ON coupon_claim; DROP FUNCTION IF EXISTS $faultName();" | Out-Null
    $cleanupFault = $false
    $retry = Read-TestOrder (Start-TestOrder $faultOrder $faultCoupon)
    Assert-Check ($retry.Status -eq 200 -and $retry.Body.orderId -eq $faultOrder -and $retry.Body.pricing.totalCents -eq 10000) 'same order succeeds after the fault is removed'
    Write-Host 'PASS 5/5: injected failure rolls back both writes and retry succeeds'
    Write-Host 'CHECKOUT ACCEPTANCE PASSED'
} finally {
    try {
        if ($cleanupFault) {
            Invoke-TestSql "DROP TRIGGER IF EXISTS $faultName ON coupon_claim; DROP FUNCTION IF EXISTS $faultName();" | Out-Null
        }
    } finally {
        if ($client) { $client.Dispose() }
        Pop-Location
    }
}
