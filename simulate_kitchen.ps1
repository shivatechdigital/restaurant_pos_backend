<#
.SYNOPSIS
  Kitchen simulator - orders/status ko ek step aage badhata hai (Postman ke bina).
  Run karo baar baar: placed -> accepted -> preparing -> ready -> served.

.PARAMETER RestaurantId
  Jis restaurant ka active order advance karna hai (default: 1).

.PARAMETER OrderId
  Optional. Specific order_id do, warna restaurant ka sabse latest active order use hoga.
#>
param(
    [int]$RestaurantId = 1,
    [int]$OrderId = 0,
    [string]$BaseUrl = "http://localhost:3000/api"
)

$ErrorActionPreference = "Stop"

# ---- STEP 1: .env se JWT_SECRET nikaalo ----
$envPath = Join-Path $PSScriptRoot ".env"
if (-not (Test-Path $envPath)) {
    Write-Host "ERROR: .env nahi mila: $envPath" -ForegroundColor Red
    exit 1
}

$jwtSecret = (Get-Content $envPath | Where-Object { $_ -match '^JWT_SECRET=' }) -replace '^JWT_SECRET=', ''
if ([string]::IsNullOrWhiteSpace($jwtSecret)) {
    Write-Host "ERROR: JWT_SECRET .env mein nahi mila" -ForegroundColor Red
    exit 1
}

# ---- STEP 2: Base64Url helper ----
function ConvertTo-Base64Url {
    param([byte[]]$Bytes)
    $b64 = [Convert]::ToBase64String($Bytes)
    return $b64.TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

# ---- STEP 3: Waiter JWT banao (HS256) ----
function New-WaiterJwt {
    param([string]$Secret, [int]$RestaurantId)

    $header = '{"alg":"HS256","typ":"JWT"}'
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $exp = $now + 3600
    $payload = "{`"id`":1,`"phone`":`"9999999999`",`"role`":`"waiter`",`"restaurant_id`":$RestaurantId,`"iat`":$now,`"exp`":$exp}"

    $headerB64 = ConvertTo-Base64Url ([System.Text.Encoding]::UTF8.GetBytes($header))
    $payloadB64 = ConvertTo-Base64Url ([System.Text.Encoding]::UTF8.GetBytes($payload))
    $signingInput = "$headerB64.$payloadB64"

    $hmac = New-Object System.Security.Cryptography.HMACSHA256
    $hmac.Key = [System.Text.Encoding]::UTF8.GetBytes($Secret)
    $signatureBytes = $hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($signingInput))
    $signatureB64 = ConvertTo-Base64Url $signatureBytes

    return "$signingInput.$signatureB64"
}

$token = New-WaiterJwt -Secret $jwtSecret -RestaurantId $RestaurantId
$headers = @{ Authorization = "Bearer $token" }

# ---- STEP 4: Active order dhoondo (agar OrderId nahi diya) ----
if ($OrderId -eq 0) {
    $kitchenResp = Invoke-RestMethod -Uri "$BaseUrl/orders/kitchen" -Method GET -Headers $headers
    $orders = $kitchenResp.data.orders

    if (-not $orders -or $orders.Count -eq 0) {
        Write-Host "INFO: Koi active order nahi mila (sab placed/accepted/preparing/ready se bahar hain)." -ForegroundColor Yellow
        exit 0
    }

    # Sabse latest placed order lo
    $order = $orders[-1]
    $OrderId = $order.id
    $currentStatus = $order.status
}
else {
    # Specific order diya gaya - uska current status pata karo kitchen list se
    $kitchenResp = Invoke-RestMethod -Uri "$BaseUrl/orders/kitchen" -Method GET -Headers $headers
    $order = $kitchenResp.data.orders | Where-Object { $_.id -eq $OrderId }
    if (-not $order) {
        Write-Host "INFO: Order #$OrderId active list mein nahi mila (already served/cancelled ho sakta hai)." -ForegroundColor Yellow
        exit 0
    }
    $currentStatus = $order.status
}

# ---- STEP 5: Next status decide karo ----
$sequence = @('placed', 'accepted', 'preparing', 'ready', 'served')
$currentIndex = [Array]::IndexOf($sequence, $currentStatus)

if ($currentIndex -eq -1 -or $currentIndex -eq $sequence.Length - 1) {
    Write-Host "INFO: Order #$OrderId already '$currentStatus' hai - aage badhane ko kuch nahi." -ForegroundColor Yellow
    exit 0
}

$nextStatus = $sequence[$currentIndex + 1]

# ---- STEP 6: PATCH karo ----
$body = @{ status = $nextStatus } | ConvertTo-Json
$result = Invoke-RestMethod -Uri "$BaseUrl/orders/$OrderId/status" -Method PATCH -Headers $headers -Body $body -ContentType "application/json"

Write-Host "OK: Order #$OrderId : $currentStatus -> $nextStatus" -ForegroundColor Green
Write-Host "    Customer screen par ab real-time update dikhna chahiye." -ForegroundColor Gray
