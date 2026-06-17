# make-icon.ps1 — render the Deal Watcher logo to dashboard/assets/icon.png + icon.ico
# Draws the same design as logo.svg with GDI+ (no ImageMagick needed) and packs a real
# multi-resolution .ico (PNG-compressed entries) for the Electron window, the packaged exe
# and the desktop shortcut. Run:  powershell -ExecutionPolicy Bypass -File tools/make-icon.ps1
Add-Type -AssemblyName System.Drawing

$assets = Join-Path $PSScriptRoot '..\dashboard\assets'
$null = New-Item -ItemType Directory -Force -Path $assets

function New-LogoBitmap([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $s = $size / 256.0
  $cx = 128 * $s; $cy = 128 * $s

  # rounded-square background, vertical gradient
  $rad = 56 * $s; $d = 2 * $rad
  $bgPath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $bgPath.AddArc(0, 0, $d, $d, 180, 90)
  $bgPath.AddArc($size - $d, 0, $d, $d, 270, 90)
  $bgPath.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
  $bgPath.AddArc(0, $size - $d, $d, $d, 90, 90)
  $bgPath.CloseFigure()
  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point(0, 0)), (New-Object System.Drawing.Point(0, $size)),
    [System.Drawing.Color]::FromArgb(0x1d, 0x26, 0x33), [System.Drawing.Color]::FromArgb(0x0b, 0x0e, 0x13))
  $g.FillPath($bg, $bgPath)

  # vinyl record — off-centre radial for a sheen
  $r = 90 * $s
  $vp = New-Object System.Drawing.Drawing2D.GraphicsPath
  $vp.AddEllipse($cx - $r, $cy - $r, 2 * $r, 2 * $r)
  $pg = New-Object System.Drawing.Drawing2D.PathGradientBrush($vp)
  $pg.CenterPoint = New-Object System.Drawing.PointF(($cx - $r * 0.22), ($cy - $r * 0.32))
  $pg.CenterColor = [System.Drawing.Color]::FromArgb(0x22, 0x2b, 0x38)
  $pg.SurroundColors = @([System.Drawing.Color]::FromArgb(0x07, 0x0a, 0x0f))
  $g.FillPath($pg, $vp)

  # grooves
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(200, 0x2b, 0x35, 0x43), [float](2 * $s))
  foreach ($rr in 80, 70, 60, 50) { $g.DrawEllipse($pen, $cx - $rr * $s, $cy - $rr * $s, 2 * $rr * $s, 2 * $rr * $s) }

  # green centre label = price-drop disc
  $lr = 38 * $s
  $lblRect = New-Object System.Drawing.RectangleF(($cx - $lr), ($cy - $lr), (2 * $lr), (2 * $lr))
  $lbl = New-Object System.Drawing.Drawing2D.LinearGradientBrush($lblRect,
    [System.Drawing.Color]::FromArgb(0x34, 0xe0, 0x7e), [System.Drawing.Color]::FromArgb(0x1a, 0xa2, 0x58), 90)
  $g.FillEllipse($lbl, $lblRect)

  # white down-arrow (same polygon as logo.svg)
  $coords = @(119, 103, 135, 103, 135, 125, 150, 125, 127, 151, 104, 125, 119, 125)
  $pts = @()
  for ($i = 0; $i -lt $coords.Length; $i += 2) {
    $pts += New-Object System.Drawing.PointF(($coords[$i] * $s), ($coords[$i + 1] * $s))
  }
  $g.FillPolygon([System.Drawing.Brushes]::White, [System.Drawing.PointF[]]$pts)

  $g.Dispose()
  return $bmp
}

function Get-PngBytes($bmp) {
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  # Wrap with the comma operator so PowerShell does NOT unroll the byte[] into the pipeline
  # (which would re-collect it as Object[] and break BinaryWriter.Write).
  return , $ms.ToArray()
}

# 256px PNG for the Electron BrowserWindow icon
$big = New-LogoBitmap 256
[System.IO.File]::WriteAllBytes((Join-Path $assets 'icon.png'), (Get-PngBytes $big))
$big.Dispose()

# multi-resolution .ico (PNG entries) for the exe + desktop shortcut
$sizes = 256, 128, 64, 48, 32, 16
$imgs = foreach ($sz in $sizes) { $b = New-LogoBitmap $sz; $bytes = Get-PngBytes $b; $b.Dispose(); [pscustomobject]@{ size = $sz; bytes = $bytes } }

$out = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($out)
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$imgs.Count)   # ICONDIR
$offset = 6 + 16 * $imgs.Count
foreach ($im in $imgs) {
  $w = if ($im.size -ge 256) { 0 } else { $im.size }
  $bw.Write([byte]$w); $bw.Write([byte]$w); $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([uint16]1); $bw.Write([uint16]32)
  $bw.Write([uint32]$im.bytes.Length); $bw.Write([uint32]$offset)
  $offset += $im.bytes.Length
}
foreach ($im in $imgs) { $bw.Write([byte[]]$im.bytes) }
$bw.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $assets 'icon.ico'), $out.ToArray())
$bw.Dispose()

Write-Host "Wrote icon.png (256) + icon.ico ($($imgs.Count) sizes) to dashboard/assets"
