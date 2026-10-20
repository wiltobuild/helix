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
using System.Threading.Tasks;
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
  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();
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
  public static async Task Pump(Stream source, Stream target, bool closeTarget) {
    try {
      byte[] bytes = new byte[8192];
      int count;
      while ((count = await source.ReadAsync(bytes, 0, bytes.Length).ConfigureAwait(false)) > 0) {
        await target.WriteAsync(bytes, 0, count).ConfigureAwait(false);
        // Process.StandardInput.BaseStream is buffered even without a StreamWriter.
        // Every protocol frame must be visible before the next read blocks.
        await target.FlushAsync().ConfigureAwait(false);
      }
    } finally { if (closeTarget) target.Close(); }
  }
}
'@
  [HelixProcessJob]::Enter()
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
  $inputCopy = [HelixProcessJob]::Pump([Console]::OpenStandardInput(), $agentProcess.StandardInput.BaseStream, $true)
  $outputCopy = [HelixProcessJob]::Pump($agentProcess.StandardOutput.BaseStream, [Console]::OpenStandardOutput(), $false)
  $errorCopy = [HelixProcessJob]::Pump($agentProcess.StandardError.BaseStream, [Console]::OpenStandardError(), $false)
  $agentProcess.WaitForExit()
  # A detached descendant may hold a pipe open. Bound draining before exit closes
  # the job handle and terminates that descendant as well.
  [void]$outputCopy.Wait(1000)
  [void]$errorCopy.Wait(1000)
  [Environment]::Exit($agentProcess.ExitCode)
} catch {
  [Console]::Error.WriteLine('Helix Windows process supervisor failed: ' + $_.Exception.Message)
  [Environment]::Exit(1)
}
