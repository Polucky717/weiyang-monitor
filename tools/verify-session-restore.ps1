# 只读验证：确认登录态快照会在后台重启后自动回填，不需要重新登录。
#
# 为什么单独做一个脚本：验证"重启不丢登录"**必须真的重启后台**，而这会
# 短暂打断用户正在看的界面。让用户自己按一下、而不是由我擅自重启，更稳妥；
# 同时也把这个验收动作固定成可重复的一条命令。
#
# 这个脚本只做两件事：重启后台、把两次的关键日志打出来。
# 它**不会**碰浏览器配置目录，也**不会**要求重新登录。

param(
  [int]$Port = 8787
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$scanLog = Join-Path $root 'logs\scan.log'
$sessionFile = Join-Path $root '.weiyang-session.json'

function Write-Section([string]$Text) {
  Write-Host ''
  Write-Host "=== $Text ===" -ForegroundColor Cyan
}

Write-Host ''
Write-Host '未央观察站 —— 验证登录态在重启后自动恢复' -ForegroundColor White
Write-Host '（本脚本不会要求重新登录；只是重启后台并对比日志）' -ForegroundColor Gray

# ---------- 0. 先确认有快照 ----------
Write-Section '0. 登录态快照'
if (-not (Test-Path -LiteralPath $sessionFile)) {
  Write-Host '  找不到 .weiyang-session.json —— 请先双击 relogin-monitor.cmd 登录一次。' -ForegroundColor Red
  Write-Host '  （快照是在登录完成时生成的）' -ForegroundColor Gray
  exit 1
}
try {
  $snap = Get-Content -LiteralPath $sessionFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $cookieCount = @($snap.state.cookies).Count
  Write-Host "  保存时间   : $($snap.savedAt)" -ForegroundColor Green
  Write-Host "  触发原因   : $($snap.why)"
  Write-Host "  cookie     : $cookieCount 个（其中会话级 $($snap.sessionCookieCount) 个）" -ForegroundColor Green
  $hasSession = @($snap.cookieNames) -match 'sessionid'
  if ($hasSession) {
    Write-Host '  sessionid  : 有 ✓（这就是登录凭据）' -ForegroundColor Green
  } else {
    Write-Host '  sessionid  : 没有 —— 快照里不含登录凭据，回填不会有用。' -ForegroundColor Red
    Write-Host '               请重新登录一次再跑本脚本。' -ForegroundColor Yellow
  }
} catch {
  Write-Host "  快照读不出来：$($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

# ---------- 1. 重启后台 ----------
Write-Section '1. 重启后台'
$stopped = 0
try {
  $listeners = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
  foreach ($l in $listeners) {
    try {
      Stop-Process -Id $l.OwningProcess -Force -ErrorAction Stop
      Write-Host "  已停止 PID=$($l.OwningProcess)"
      $stopped += 1
    } catch {
      Write-Host "  停止 PID=$($l.OwningProcess) 失败：$($_.Exception.Message)" -ForegroundColor Yellow
    }
  }
} catch {
  Write-Host "  （查询监听端口失败：$($_.Exception.Message)）" -ForegroundColor Yellow
}
if ($stopped -eq 0) { Write-Host '  没有发现占用该端口的后台。' }

# 等端口释放
for ($i = 0; $i -lt 20; $i += 1) {
  Start-Sleep -Milliseconds 500
  if (-not (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)) { break }
}

$env:PORT = "$Port"
Start-Process -FilePath 'node' -ArgumentList @('src\server.js') -WorkingDirectory $root -WindowStyle Hidden
Write-Host '  已重新启动后台。' -ForegroundColor Green

# ---------- 2. 等后台就绪 ----------
Write-Section '2. 等待后台就绪'
$ready = $false
for ($i = 0; $i -lt 40; $i += 1) {
  Start-Sleep -Seconds 1
  try {
    Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/state" -TimeoutSec 3 | Out-Null
    $ready = $true
    Write-Host "  后台已就绪（等了 $($i + 1) 秒）。" -ForegroundColor Green
    break
  } catch { }
}
if (-not $ready) {
  Write-Host '  后台在 40 秒内没有就绪，请手动检查。' -ForegroundColor Red
  exit 1
}

# ---------- 3. 触发一次扫描（等价于下一次自动轮询） ----------
Write-Section '3. 触发一次扫描'
$state = $null
try {
  $state = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/scan" -Method Post -TimeoutSec 120
  Write-Host "  status=$($state.backend.status)  authRequired=$($state.backend.authRequired)"
  Write-Host "  error=$($state.backend.error)"
  Write-Host "  totalPoints=$($state.profile.totalPoints)" -ForegroundColor Green
} catch {
  Write-Host "  扫描请求出错：$($_.Exception.Message)" -ForegroundColor Yellow
}

# ---------- 4. 对照日志判定 ----------
Write-Section '4. 本次启动以来的日志'
if (Test-Path -LiteralPath $scanLog) {
  # 只看最近一次后台启动之后的日志：否则上一次会话的 401 会把结论带偏
  $lines = @(Get-Content -LiteralPath $scanLog -Encoding UTF8)
  $start = -1
  for ($i = $lines.Count - 1; $i -ge 0; $i--) {
    if ($lines[$i] -match '后台已启动') { $start = $i; break }
  }
  $seg = if ($start -ge 0) { @($lines[$start..($lines.Count - 1)]) } else { @($lines | Select-Object -Last 30) }
  foreach ($line in $seg) {
    # 只打关键行，避免几十行诊断把结论淹没
    if ($line -match '后台已启动|\[登录态\]|\[积分页\] 落点|\[积分\] 板块合计|\[登录\]|扫描失败') {
      Write-Host "    $line"
    }
  }

  $refilled = $seg | Where-Object { $_ -match '\[登录态\] 已回填' }
  $gotBoards = $seg | Where-Object { $_ -match '\[积分页\].*板块数=([1-9]\d*)' }
  $noLogin = -not ($seg | Where-Object { $_ -match '没有登[录陆]' })

  Write-Host ''
  if ($refilled) { Write-Host '  登录态已从快照回填 ✓' -ForegroundColor Green }
  else { Write-Host '  没有看到回填日志 —— 快照可能没被读取。' -ForegroundColor Yellow }

  if ($gotBoards -and $noLogin) {
    Write-Host '  PASS —— 重启后没有重新登录也抓到了板块数据。' -ForegroundColor Green
    Write-Host '  这就是"保存登录信息用于重新登录"生效的证据。' -ForegroundColor Green
  } elseif ($noLogin) {
    Write-Host '  没有报登录失效，但也没抓到板块，请把上面的日志发给开发者。' -ForegroundColor Yellow
  } else {
    Write-Host '  FAIL —— 重启后仍然报"您没有登陆"。' -ForegroundColor Red
    Write-Host '  请把上面的日志发给开发者：可能 sessionid 在服务端已被失效。' -ForegroundColor Yellow
  }
}

Write-Host ''
Write-Host '（这个脚本不会重新登录，也不改浏览器配置目录）' -ForegroundColor Gray
Write-Host ''
