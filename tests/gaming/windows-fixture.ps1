# 只创建并控制本次测试的窗口，不枚举/修改用户程序。stdin/stdout 是测试协议。
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing @'
using System;
using System.Drawing;
using System.Threading;
using System.Windows.Forms;
using System.Runtime.InteropServices;
public class GamingFixtureForm : Form {
  public Color Fill;
  protected override void OnPaint(PaintEventArgs e) {
    e.Graphics.Clear(Fill);
    e.Graphics.FillRectangle(Brushes.Gold,ClientSize.Width/3,ClientSize.Height/3,70,50);
  }
}
public static class GamingFixture {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from,uint to,bool attach);
  static Thread thread;
  static GamingFixtureForm normal,small,blank,cover;
  static IntPtr oldForeground;
  static GamingFixtureForm Form(string key) { return key=="normal"?normal:key=="small"?small:key=="blank"?blank:cover; }
  static GamingFixtureForm Make(string title,int w,int h,Color color) {
    var f=new GamingFixtureForm();f.Text=title;f.StartPosition=FormStartPosition.Manual;
    f.Location=new Point(100,100);f.ClientSize=new Size(w,h);f.Fill=color;f.ShowInTaskbar=false;f.Show();return f;
  }
  public static void Start(string prefix) {
    oldForeground=GetForegroundWindow();SetProcessDPIAware();
    var ready=new ManualResetEvent(false);
    thread=new Thread(delegate() {
      normal=Make(prefix+" MAIN",640,360,Color.ForestGreen);
      small=Make(prefix+" MAIN small",220,140,Color.Purple);
      blank=Make(prefix+" BLANK",500,300,Color.Teal);
      cover=Make(prefix+" COVER",800,500,Color.RoyalBlue);
      ready.Set();Application.Run(normal);
    });
    thread.SetApartmentState(ApartmentState.STA);thread.IsBackground=true;thread.Start();
    if(!ready.WaitOne(10000))throw new Exception("fixture startup timeout");
  }
  public static long Handle(string key) { return Form(key).Handle.ToInt64(); }
  public static bool Activate(string key) {
    var f=Form(key);normal.Invoke((Action)delegate() {
      uint pid;uint foregroundThread=GetWindowThreadProcessId(GetForegroundWindow(),out pid),current=GetCurrentThreadId();
      bool attached=foregroundThread!=0 && foregroundThread!=current && AttachThreadInput(current,foregroundThread,true);
      try { f.WindowState=FormWindowState.Normal;f.BringToFront();f.Activate();SetForegroundWindow(f.Handle); }
      finally { if(attached)AttachThreadInput(current,foregroundThread,false); }
    });
    Thread.Sleep(150);return GetForegroundWindow()==f.Handle;
  }
  public static void Minimize(string key) { normal.Invoke((Action)delegate() { Form(key).WindowState=FormWindowState.Minimized; });Thread.Sleep(100); }
  public static string Inspect(string file) {
    using(var image=new Bitmap(file)) { var pixel=image.GetPixel(4,4);return image.Width+","+image.Height+","+pixel.R+","+pixel.G+","+pixel.B; }
  }
  public static void Stop() {
    if(normal!=null && !normal.IsDisposed)normal.Invoke((Action)delegate() { small.Close();blank.Close();cover.Close();normal.Close(); });
    if(thread!=null)thread.Join(3000);
    if(oldForeground!=IntPtr.Zero)SetForegroundWindow(oldForeground);
  }
}
'@
$prefix = 'CorticoGamingFixture-' + [Guid]::NewGuid().ToString('N')
try {
  [GamingFixture]::Start($prefix)
  $processName = [System.Diagnostics.Process]::GetCurrentProcess().ProcessName
  Write-Output (@{ok=$true;prefix=$prefix;proc=$processName} | ConvertTo-Json -Compress)
  while ($null -ne ($line = [Console]::ReadLine())) {
    try {
      $command = $line | ConvertFrom-Json
      $value = $null
      switch ($command.action) {
        'activate' { $value = [GamingFixture]::Activate($command.key) }
        'minimize' { [GamingFixture]::Minimize($command.key); $value = $true }
        'handle' { $value = [GamingFixture]::Handle($command.key).ToString() }
        'inspect' { $value = [GamingFixture]::Inspect($command.file) }
        'stop' { Write-Output '{"ok":true}'; break }
        default { throw 'unknown fixture command' }
      }
      if ($command.action -eq 'stop') { break }
      Write-Output (@{ok=$true;value=$value} | ConvertTo-Json -Compress)
    } catch { Write-Output '{"ok":false,"error":"fixture command failed"}' }
  }
} finally { [GamingFixture]::Stop() }
