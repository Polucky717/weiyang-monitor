param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Message,
  [string]$ActivityUrl = '',
  [string]$ActivityTitle = '',
  [int]$Port = 8787,
  [int]$DurationSeconds = 60,
  [string]$TraceLog = '',
  # activity = 新活动提醒（按钮：立刻报名 / 查看目前积分）
  # auth     = 登录失效提醒（按钮：确认 / 稍后提醒我，后者可悬停选时间）
  [ValidateSet('activity', 'auth')][string]$Mode = 'activity'
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
Write-Trace ("启动 pid=" + $PID + " mode=" + $Mode + " title=" + $Title + " duration=" + $DurationSeconds)

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
# 登录失效提醒的标题是固定的：这时候"活动名"没有意义，用户要一眼看出是登录出了问题。
if ($Mode -eq 'auth') {
  $eyebrow.Text = '未央雨课堂  /  登录状态'
  $activityTitle = '需要重新登录'
}
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

if ($Mode -eq 'auth') {
  # 登录失效提醒只给两个动作：确认（我知道了）/ 稍后提醒我（推迟再提示）。
  # “确认”直接复用已有的 $close，只改文字，避免再造一套关闭逻辑；
  # “查看目前积分 / 立刻报名”在这种状态下没有意义，直接隐藏（Visible=$false
  # 的控件不参与 FlowLayoutPanel 排版，所以不会留空位）。
  $close.Text = '确认'
  $close.Size = New-Object Drawing.Size(96, 40)
  $points.Visible = $false
  $signup.Visible = $false

  $snoozeDefaultMinutes = 15
  $script:snoozePending = $false

  $snooze = New-Object Windows.Forms.Button
  $snooze.Text = '稍后提醒我 ▾'
  $snooze.Size = New-Object Drawing.Size(150, 40)
  $snooze.Font = $font
  $snooze.FlatStyle = 'Flat'
  $snooze.FlatAppearance.BorderColor = $line
  $snooze.BackColor = [Drawing.Color]::White
  $snooze.ForeColor = $ink

  # 悬停展开的时间菜单。放在按钮上方：按钮贴着窗口底部，往下弹会被屏幕边缘截掉。
  $snoozeMenu = New-Object Windows.Forms.ContextMenuStrip
  $snoozeMenu.ShowImageMargin = $false
  foreach ($option in @(@(15, '15 分钟后（默认）'), @(30, '30 分钟后'), @(60, '1 小时后'), @(120, '2 小时后'))) {
    $item = New-Object Windows.Forms.ToolStripMenuItem([string]$option[1])
    $item.Tag = [int]$option[0]
    $item.Add_Click({ Invoke-Snooze ([int]$this.Tag) })
    [void]$snoozeMenu.Items.Add($item)
  }

  # 把选中的分钟数发给本地后台：后台据此把“下次提醒时间”推到他选的时刻，
  # 并用定时器在到点时精确再弹一次。只改状态是不够的 —— 扫描半小时一轮，
  # 用户选 15 分钟却要等最多 30 分钟才提醒，按钮就等于没生效。
  function Invoke-Snooze([int]$minutes) {
    if ($script:snoozePending) { return }
    $script:snoozePending = $true
    $snooze.Enabled = $false
    $snooze.Text = '正在设置…'
    try {
      $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes((@{ minutes = $minutes } | ConvertTo-Json -Compress))
      Invoke-RestMethod -Method Post -Uri ('http://127.0.0.1:' + $Port + '/api/auth/snooze') -Body $bodyBytes -ContentType 'application/json; charset=utf-8' -TimeoutSec 5 | Out-Null
      Write-Trace ('稍后提醒：已请求推迟 ' + $minutes + ' 分钟')
    } catch {
      Write-Trace ('稍后提醒：请求失败 ' + $_.Exception.Message)
    }
    $script:closedBySnooze = $true
    $form.Close()
  }

  $snooze.Add_MouseEnter({
    if ($snoozeMenu.Visible) { return }
    $size = $snoozeMenu.GetPreferredSize((New-Object Drawing.Size(0, 0)))
    $offset = if ($size.Height -gt 0) { - ($size.Height + 6) } else { -150 }
    $snoozeMenu.Show($snooze, (New-Object Drawing.Point(0, $offset)))
  })
  # 直接点按钮 = 用默认的 15 分钟（用户要求：不选择就按 15 分钟算）。
  $snooze.Add_Click({ Invoke-Snooze $snoozeDefaultMinutes })

  $footer.Controls.Add($snooze)
}

$rows = New-Object 'System.Collections.Generic.List[object]'
$descriptionLines = New-Object 'System.Collections.Generic.List[string]'
foreach ($lineText in ($Message -split "`r?`n")) {
  if ($lineText -match '^板块[：:](.*)$') { $rows.Add(@('所属板块', $Matches[1].Trim())) }
  elseif ($lineText -match '^类型[：:](.*)$') { $rows.Add(@('活动类型', $Matches[1].Trim())) }
  elseif ($lineText -match '^项目简介[：:](.*)$') { if ($Matches[1].Trim()) { $descriptionLines.Add($Matches[1].Trim()) } }
  elseif ($descriptionLines.Count -gt 0) { $descriptionLines.Add($lineText.Trim()) }
}
if ($descriptionLines.Count -gt 0) { $rows.Add(@('项目简介', ($descriptionLines -join "`r`n"))) }
if ($Mode -eq 'auth') {
  # 登录失效时的正文是固定的两行说明，不解析活动信息 —— 那时候活动数据本来就已经过期了。
  # 不写“怎么点稍后提醒”这种操作说明：按钮和悬停菜单本身就说明了用法。
  $rows.Clear()
  $rows.Add(@('当前状态', '登录已失效，监测已暂停，积分不会再更新。'))
  $rows.Add(@('怎么恢复', '双击项目目录里的 relogin-monitor.cmd，按提示重新登录即可。'))
} elseif ($rows.Count -eq 0) { $rows.Add(@('活动信息', $Message.Trim())) }

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
# DurationSeconds <= 0 表示**不自动关闭**，必须由用户手动关窗口（或点“立刻报名”）。
#
# 为什么要有这个模式：原来固定 60 秒自动关闭，用户不在电脑前（实测去吃饭/锁屏）
# 回来时窗口早已消失，而“新活动”只会提醒一次，于是这个提醒就永久丢了。
# 提醒窗口是“需要你动手”的通知，宁可一直挡在屏幕上，也不能悄悄消失。
# 传正数时仍然是原来的自动关闭行为（登录失效提醒用 20 秒）。
$autoClose = $DurationSeconds -gt 0
$lifetimeSeconds = $DurationSeconds
$closedByTimer = $false
# 用 $script: 写：这个变量是在事件处理器 / 函数里赋值的，不带前缀会变成局部变量，
# FormClosed 里读到的永远是 $false。
$script:closedBySnooze = $false
if ($autoClose) {
  $timer.Add_Tick({
    if ($expiry.Elapsed.TotalSeconds -ge $lifetimeSeconds) {
      $script:closedByTimer = $true
      $timer.Stop()
      $form.Close()
    }
  })
}
$form.Add_Shown({
  # 强制显示窗口（关键的一步）。
  #
  # 后台用 spawn(windowsHide: true) 启动本脚本，进程带 CREATE_NO_WINDOW + SW_HIDE：
  # 好处是没有那个空的黑色控制台，坏处是**进程的第一次 ShowWindow 会被启动信息里的
  # “隐藏”覆盖掉** —— 于是窗口"已显示"（Shown 事件照常触发、日志照常写）却根本看不见。
  # 实测截屏确认过：窗口进程活着、日志写着已显示，屏幕上什么都没有。
  # 这里再显式调一次 ShowWindow(SW_SHOW)：第二次调用不再被启动信息覆盖，窗口真正出现。
  try {
    if (-not ('WeiyangWindow.Native' -as [type])) {
      Add-Type -Namespace WeiyangWindow -Name Native -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);'
    }
    [void][WeiyangWindow.Native]::ShowWindow($form.Handle, 5)
    [void][WeiyangWindow.Native]::SetForegroundWindow($form.Handle)
    Write-Trace '已强制显示窗口（SW_SHOW）'
  } catch {
    Write-Trace ('强制显示窗口失败：' + $_.Exception.Message)
  }
  $form.Activate()
  $form.TopMost = $true
  $form.BringToFront()
  $expiry.Restart()
  if ($autoClose) {
    $timer.Start()
    Write-Trace ("窗口已显示，计划显示 " + $lifetimeSeconds + " 秒")
  } else {
    Write-Trace '窗口已显示，不自动关闭（等用户手动关闭）'
  }
})
$form.Add_FormClosed({
  $timer.Stop()
  $timer.Dispose()
  $how = if ($closedByTimer) { '自动超时' } elseif ($script:closedBySnooze) { '设置了稍后提醒' } else { '手动关闭（确认/关闭按钮）' }
  Write-Trace ("窗口关闭（" + $how + "），实际显示 " + [Math]::Round($expiry.Elapsed.TotalSeconds, 1) + " 秒")
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
