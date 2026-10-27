# Own a non-inheritable kill-on-close job before starting the CLI. Node retains
# this supervisor's process handle, so stop works even when taskkill/OpenProcess
# is denied by a restricted Windows token. Nested jobs require Windows 8+.
param([Parameter(Mandatory=$true)][string]$Launch)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;
public static class HelixProcessJob {
  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimits {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IoCounters {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimits {
    public BasicLimits BasicLimitInformation;
    public IoCounters IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  public static bool AssignProcess(IntPtr process) {
    if (job != IntPtr.Zero && process != IntPtr.Zero) {
      return AssignProcessToJobObject(job, process);
    }
    return false;
  }
  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern IntPtr GetStdHandle(int kind);
  static readonly bool debug = Environment.GetEnvironmentVariable("HELIX_DEBUG_PROCESS") == "1";
  public static void Stage(string stage) {
    if (debug) Console.Error.WriteLine("[Helix process {0:O}] {1}", DateTime.UtcNow, stage);
  }
  public static Stream StandardStream(int kind, bool input) {
    // Node gives us redirected pipe handles. Avoid __ConsoleStream's console
    // input wait and encoding-dependent path in console-less service sessions.
    // These handles belong to the process; FileStream must not own/close them.
    var handle = new SafeFileHandle(GetStdHandle(kind), false);
    if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
    return new FileStream(handle, input ? FileAccess.Read : FileAccess.Write, 1, false);
  }
  // Keep the only job handle alive until process teardown. Do not close it while
  // this process is running: it belongs to the job, too.
  static IntPtr job;
  public static void Enter() {
    job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    var limits = new ExtendedLimits();
    limits.BasicLimitInformation.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))))
      throw new Win32Exception(Marshal.GetLastWin32Error());
    if (!AssignProcessToJobObject(job, GetCurrentProcess()))
      throw new Win32Exception(Marshal.GetLastWin32Error());
  }
  public static Thread Pump(Stream source, Stream target, bool closeTarget, string direction) {
    // Framework pipe async operations can use blocking worker-pool work. Give
    // each direction its own thread: no runspace, synchronization context, or
    // thread-pool availability is required to move the next protocol frame.
    var thread = new Thread(delegate() {
      try {
        byte[] bytes = new byte[8192];
        int count;
        bool first = true;
        while ((count = source.Read(bytes, 0, bytes.Length)) > 0) {
          target.Write(bytes, 0, count);
          // StandardInput.BaseStream is buffered even without a StreamWriter.
          target.Flush();
          if (first) { first = false; Stage("first " + direction + " byte"); }
        }
      } catch (Exception error) {
        // Unlike the old unobserved stdin Task, surface every pump failure.
        Console.Error.WriteLine("Helix Windows process supervisor {0} pump failed: {1}", direction, error);
      } finally {
        if (closeTarget) {
          try { target.Close(); }
          catch (Exception error) { Console.Error.WriteLine("Helix Windows process supervisor close failed: " + error); }
        }
      }
    });
    thread.IsBackground = true;
    thread.Name = "Helix " + direction;
    thread.Start();
    return thread;
  }
}
'@
  [HelixProcessJob]::Stage('compiled')
  [HelixProcessJob]::Enter()
  [HelixProcessJob]::Stage('job entered')
  $configuration = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Launch)) | ConvertFrom-Json
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $configuration.bin
  $startInfo.Arguments = $configuration.arguments
  $startInfo.WorkingDirectory = $configuration.cwd
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  # Copy raw byte streams, without PowerShell's text pipeline or StreamWriter's
  # buffering/encoding conversion. All three directions progress independently.
  $agentProcess = [System.Diagnostics.Process]::Start($startInfo)
  try { [HelixProcessJob]::AssignProcess($agentProcess.Handle) } catch {}
  [HelixProcessJob]::Stage('child started pid=' + $agentProcess.Id)
  $inputCopy = [HelixProcessJob]::Pump([HelixProcessJob]::StandardStream(-10, $true), $agentProcess.StandardInput.BaseStream, $true, 'stdin')
  $outputCopy = [HelixProcessJob]::Pump($agentProcess.StandardOutput.BaseStream, [HelixProcessJob]::StandardStream(-11, $false), $false, 'stdout')
  $errorCopy = [HelixProcessJob]::Pump($agentProcess.StandardError.BaseStream, [HelixProcessJob]::StandardStream(-12, $false), $false, 'stderr')
  $agentProcess.WaitForExit()
  # A detached descendant may hold a pipe open. Bound draining before exit closes
  # the job handle and terminates that descendant as well.
  [void]$outputCopy.Join(1000)
  [void]$errorCopy.Join(1000)
  [Environment]::Exit($agentProcess.ExitCode)
} catch {
  [Console]::Error.WriteLine('Helix Windows process supervisor failed: ' + $_.Exception.ToString())
  [Environment]::Exit(1)
}
