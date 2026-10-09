param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Message,
  [string]$ActivityUrl = '',
  [string]$ActivityTitle = '',
  [int]$Port = 8787,
  [int]$DurationSeconds = 60,
  [string]$TraceLog = ''
)

# 把执行轨迹写进日志文件。提醒窗口一旦弹不出来，事后无法从任何地方查证，
# 因此每次运行都留下“走到哪一步 / 抛了什么异常”的记录。
$tracePath = $TraceLog
if ([string]::IsNullOrWhiteSpace($tracePath)) {
  # 本脚本在 scripts/ 下，而 logs/ 在项目根，所以要上退一级。
  $ProjectRoot = Split-Path -Parent $PSScriptRoot
  $tracePath = Join-Path $ProjectRoot 'logs\notify-trace.log'
}
function Write-Trace([string]$message) {
  try {
    $dir = Split-Path -Parent $tracePath
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Add-Content -Path $tracePath -Encoding UTF8 -Value ("[" + $stamp + "] " + $message)
  } catch { }
}
Write-Trace ("启动 pid=" + $PID + " title=" + $Title + " duration=" + $DurationSeconds)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ink = [Drawing.Color]::FromArgb(34, 48, 48)
$muted = [Drawing.Color]::FromArgb(101, 117, 126)
$accent = [Drawing.Color]::FromArgb(12, 121, 181)
$line = [Drawing.Color]::FromArgb(222, 232, 239)
$canvas = [Drawing.Color]::FromArgb(248, 251, 253)
$font = New-Object Drawing.Font('Microsoft YaHei', 10)
$smallFont = New-Object Drawing.Font('Microsoft YaHei', 9)

$form = New-Object Windows.Forms.Form
$form.Text = $Title
$form.ClientSize = New-Object Drawing.Size(680, 470)
$form.MinimumSize = New-Object Drawing.Size(680, 470)
$form.MaximumSize = New-Object Drawing.Size(680, 470)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.ShowInTaskbar = $true
$form.TopMost = $true
$form.BackColor = [Drawing.Color]::White

$header = New-Object Windows.Forms.Panel
$header.Dock = 'Top'
$header.Height = 104
$header.BackColor = $canvas
$stripe = New-Object Windows.Forms.Panel
$stripe.Dock = 'Left'
$stripe.Width = 5
$stripe.BackColor = $accent
$eyebrow = New-Object Windows.Forms.Label
$eyebrow.Location = New-Object Drawing.Point(25, 16)
$eyebrow.Size = New-Object Drawing.Size(600, 20)
$eyebrow.Text = '未央雨课堂  /  新活动提醒'
$eyebrow.Font = $smallFont
$eyebrow.ForeColor = $accent
$activityTitle = ($Message -split "`r?`n" | Where-Object { $_ -match '^活动[：:]' } | Select-Object -First 1) -replace '^活动[：:]\s*', ''
if ([string]::IsNullOrWhiteSpace($activityTitle)) { $activityTitle = '发现一项新活动' }
$headline = New-Object Windows.Forms.Label
$headline.Location = New-Object Drawing.Point(25, 42)
$headline.Size = New-Object Drawing.Size(615, 48)
$headline.Text = $activityTitle
$headline.Font = New-Object Drawing.Font('Microsoft YaHei', 16, [Drawing.FontStyle]::Bold)
$headline.ForeColor = $ink
$headline.AutoEllipsis = $true
$header.Controls.AddRange(@($stripe, $eyebrow, $headline))

$content = New-Object Windows.Forms.Panel
$content.Dock = 'Fill'
$content.AutoScroll = $true
$content.BackColor = [Drawing.Color]::White
$content.Padding = New-Object Windows.Forms.Padding(24, 17, 24, 14)

$footer = New-Object Windows.Forms.FlowLayoutPanel
$footer.Dock = 'Bottom'
$footer.Height = 68
$footer.FlowDirection = 'RightToLeft'
$footer.WrapContents = $false
$footer.Padding = New-Object Windows.Forms.Padding(18, 12, 22, 10)
$footer.BackColor = $canvas

$close = New-Object Windows.Forms.Button
$close.Text = '关闭'
$close.Size = New-Object Drawing.Size(88, 40)
$close.Font = $font
$close.FlatStyle = 'Flat'
$close.FlatAppearance.BorderColor = $line
$close.BackColor = [Drawing.Color]::White
$close.ForeColor = $ink
$close.Add_Click({ $form.Close() })

$points = New-Object Windows.Forms.Button
$points.Text = '查看目前积分'
$points.Size = New-Object Drawing.Size(148, 40)
$points.Font = $font
$points.FlatStyle = 'Flat'
$points.FlatAppearance.BorderColor = $line
$points.BackColor = [Drawing.Color]::White
$points.ForeColor = $ink
$points.Add_Click({ Start-Process 'http://127.0.0.1:8787/' })

$signup = New-Object Windows.Forms.Button
$signup.Text = '立刻报名'
$signup.Size = New-Object Drawing.Size(124, 40)
$signup.Font = $font
$signup.FlatStyle = 'Flat'
$signup.FlatAppearance.BorderSize = 0
$signup.BackColor = $accent
$signup.ForeColor = [Drawing.Color]::White
$signup.Enabled = $true

# 轮询“立刻报名”后台作业的结果。用定时器而不是 Wait-Job，正是为了让 UI 线程
# 始终空闲：点击后界面可以正常重绘、拖动、响应关闭，不会出现“程序无响应”。
# 0.4 秒一轮，作业完成即收尾；最长等 22 秒（作业自身超时 25 秒）。
# 必须定义在 Add_Click 之前，否则事件触发时 $jobTimer 还是 $null。
$jobTimer = New-Object Windows.Forms.Timer
$jobTimer.Interval = 400
$jobTimer.Add_Tick({
  if (-not $pendingJob) { $jobTimer.Stop(); return }
  $done = $pendingJob.State -ne 'Running'
  $expired = $pendingDeadline -and $pendingDeadline.Elapsed.TotalSeconds -gt 22
  if (-not $done -and -not $expired) { return }
  $jobTimer.Stop()
  $result = @()
  if ($done) { $result = Receive-Job -Job $pendingJob -ErrorAction SilentlyContinue }
  Remove-Job -Job $pendingJob -Force -ErrorAction SilentlyContinue
  $ok = $result -contains 'ok'
  Write-Trace ('立刻报名：后台调用' + $(if ($done) { '结果=' + (($result -join ',') -replace '^$', '(空)') } else { '超时（22 秒）' }))
  # 后台没能代为打开时，退回到直接打开活动地址，保证用户总能看到报名页。
  if (-not $ok -and $ActivityUrl) { Start-Process $ActivityUrl }
  $pendingJob = $null
  $form.Close()
})
# 点击“立刻报名”时回调本地后台的 /api/activity/open。这样从提醒窗口报名的活动
# 也会被记为“已报名”，和从仪表盘点击完全一致；同时由后台负责用默认浏览器打开
# 正确的活动详情页（后台走的是缓存的详情页地址，比直接开列表页更准确）。
#
# 关键：网络请求绝不能跑在 UI 线程上。WinForms 的事件处理器就运行在 UI 线程，
# 直接 Invoke-RestMethod 会把界面卡死（Windows 弹出“程序无响应”），
# 而即使用 Wait-Job 等待后台作业，UI 线程同样被阻塞，只是把卡顿从 25 秒缩短到几秒。
# 因此这里改成完全非阻塞：把请求交给后台作业，再用一个 WinForms 定时器轮询结果，
# 点击后窗口立刻变成“正在打开…”，界面全程可响应。
# 后台不可用（或标题为空）时退回到直接打开传入的活动地址。
$pendingJob = $null
$pendingDeadline = $null

$signup.Add_Click({
  if ($pendingJob) { return }   # 已经点过，避免重复提交
  $signup.Enabled = $false
  $signup.Text = '正在打开…'
  if ([string]::IsNullOrWhiteSpace($ActivityTitle)) {
    if ($ActivityUrl) { Start-Process $ActivityUrl }
    $form.Close()
    return
  }
  # 标题先编码成 Base64 再交给后台作业：活动名是外部数据，直接拼进脚本字符串
  # 会让标题里的引号、$ 等字符被当成代码展开。端口同样在父作用域固化成数字，
  # 后台作业无需依赖变量捕获。
  $payloadB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes((@{ title = $ActivityTitle } | ConvertTo-Json -Compress)))
  $portLiteral = [int]$Port
  $worker = [scriptblock]::Create(@"
`$ErrorActionPreference = 'Stop'
try {
  `$payload = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$payloadB64'))
  `$bodyBytes = [System.Text.Encoding]::UTF8.GetBytes(`$payload)
  Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:$portLiteral/api/activity/open' -Body `$bodyBytes -ContentType 'application/json; charset=utf-8' -TimeoutSec 25 | Out-Null
  'ok'
} catch { 'fail' }
"@)
  try {
    $script:pendingJob = Start-Job -ScriptBlock $worker
    $script:pendingDeadline = [System.Diagnostics.Stopwatch]::StartNew()
    $jobTimer.Start()
  } catch {
    Write-Trace ('立刻报名：无法启动后台作业：' + $_.Exception.Message)
    if ($ActivityUrl) { Start-Process $ActivityUrl }
    $form.Close()
  }
})
$footer.Controls.AddRange(@($close, $points, $signup))

$rows = New-Object 'System.Collections.Generic.List[object]'
$descriptionLines = New-Object 'System.Collections.Generic.List[string]'
foreach ($lineText in ($Message -split "`r?`n")) {
  if ($lineText -match '^板块[：:](.*)$') { $rows.Add(@('所属板块', $Matches[1].Trim())) }
  elseif ($lineText -match '^类型[：:](.*)$') { $rows.Add(@('活动类型', $Matches[1].Trim())) }
  elseif ($lineText -match '^项目简介[：:](.*)$') { if ($Matches[1].Trim()) { $descriptionLines.Add($Matches[1].Trim()) } }
  elseif ($descriptionLines.Count -gt 0) { $descriptionLines.Add($lineText.Trim()) }
}
if ($descriptionLines.Count -gt 0) { $rows.Add(@('项目简介', ($descriptionLines -join "`r`n"))) }
if ($rows.Count -eq 0) { $rows.Add(@('活动信息', $Message.Trim())) }

$y = 18
$captionFont = New-Object Drawing.Font('Microsoft YaHei', 9)
$valueFont = New-Object Drawing.Font('Microsoft YaHei', 10)
foreach ($row in $rows) {
  $caption = [string]$row[0]
  $value = [string]$row[1]
  $valueLabel = New-Object Windows.Forms.Label
  $valueLabel.Location = New-Object Drawing.Point(112, $y)
  $valueLabel.MaximumSize = New-Object Drawing.Size(492, 0)
  $valueLabel.AutoSize = $true
  $valueLabel.Text = $value
  $valueLabel.Font = $valueFont
  $valueLabel.ForeColor = $ink
  $valueLabel.UseCompatibleTextRendering = $true
  $measure = [Windows.Forms.TextRenderer]::MeasureText($value, $valueFont, (New-Object Drawing.Size(492, 2000)), [Windows.Forms.TextFormatFlags]::WordBreak -bor [Windows.Forms.TextFormatFlags]::TextBoxControl)
  $valueLabel.Height = [Math]::Max(24, $measure.Height)
  $captionLabel = New-Object Windows.Forms.Label
  $captionLabel.Location = [Drawing.Point]::new(0, [int]($y + 2))
  $captionLabel.Size = New-Object Drawing.Size(98, 24)
  $captionLabel.Text = $caption
  $captionLabel.Font = $captionFont
  $captionLabel.ForeColor = $muted
  $captionLabel.TextAlign = 'TopLeft'
  $content.Controls.AddRange(@($captionLabel, $valueLabel))
  $y += [Math]::Max(34, $valueLabel.Height) + 13
}

$form.Controls.Add($content)
$form.Controls.Add($footer)
$form.Controls.Add($header)

# 计时器：事件脚本块里用 $timer 依赖动态作用域，容易解析到 $null 而让定时器异常，
# 窗口就会提前消失。这里统一用 $this 取控件自身，并额外用一个单调时钟
# （Stopwatch）做最后的期限判定：只有真正到点才允许自动关闭。
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 500
$expiry = [System.Diagnostics.Stopwatch]::StartNew()
$lifetimeSeconds = [Math]::Max(1, $DurationSeconds)
$timer.Add_Tick({
  if ($expiry.Elapsed.TotalSeconds -ge $lifetimeSeconds) {
    $timer.Stop()
    $form.Close()
  }
})
$form.Add_Shown({
  $form.Activate()
  $form.TopMost = $true
  $form.BringToFront()
  $expiry.Restart()
  $timer.Start()
  Write-Trace ("窗口已显示，计划显示 " + $lifetimeSeconds + " 秒")
})
$form.Add_FormClosed({
  $timer.Stop()
  $timer.Dispose()
  Write-Trace ("窗口关闭，实际显示 " + [Math]::Round($expiry.Elapsed.TotalSeconds, 1) + " 秒")
  $font.Dispose(); $smallFont.Dispose(); $captionFont.Dispose(); $valueFont.Dispose()
})

# ShowDialog 会一直阻塞到窗口关闭，所以“开始显示”和“已关闭”两条日志
# 之间的间隔就说明了窗口实际存活了多久。
Write-Trace '即将 ShowDialog'
try {
  [void]$form.ShowDialog()
  Write-Trace '窗口已正常关闭'
} catch {
  Write-Trace ('显示窗口时异常：' + $_.Exception.GetType().Name + ' - ' + $_.Exception.Message)
  throw
}
Write-Trace '脚本结束'
