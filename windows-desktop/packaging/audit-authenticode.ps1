$ErrorActionPreference = 'Stop'
try {
  $Artifact = $env:MUSICMUTE_AUDIT_ARTIFACT
  $PublisherSha256 = $env:MUSICMUTE_AUDIT_PUBLISHER
  $Kind = $env:MUSICMUTE_AUDIT_KIND
  $AsarHeaderSha256 = $env:MUSICMUTE_AUDIT_ASAR
  if (![IO.Path]::IsPathRooted($Artifact) -or $PublisherSha256 -notmatch '^[a-f0-9]{64}$' -or $Kind -notin @('payload','installer')) { throw 'invalid' }
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'unsupported' }
  $item = Microsoft.PowerShell.Management\Get-Item -LiteralPath $Artifact -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -lt 64 -or $item.Length -gt 2147483648) { throw 'invalid' }
  $stream = [IO.File]::Open($item.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
  if ($stream.Length -ne $item.Length) { throw 'invalid' }
  $signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $item.FullName
  if ($signature.Status -ne 'Valid' -or !$signature.SignerCertificate -or !$signature.TimeStamperCertificate -or $signature.SignatureType -ne 'Authenticode') { throw 'invalid' }
  $hasher = [Security.Cryptography.SHA256]::Create()
  try { $publisher = ([BitConverter]::ToString($hasher.ComputeHash($signature.SignerCertificate.RawData))).Replace('-','').ToLowerInvariant() } finally { $hasher.Dispose() }
  if ($publisher -ne $PublisherSha256) { throw 'invalid' }
    $reader = New-Object IO.BinaryReader($stream)
    if ($reader.ReadUInt16() -ne 0x5a4d) { throw 'invalid' }
    $stream.Position = 60; $offset = $reader.ReadUInt32()
    if ($offset -lt 64 -or $offset -gt 1048576 -or ($offset + 26) -gt $stream.Length) { throw 'invalid' }
    $stream.Position = $offset
    if ($reader.ReadUInt32() -ne 0x00004550) { throw 'invalid' }
    $machine = $reader.ReadUInt16(); $stream.Position = $offset + 24; $magic = $reader.ReadUInt16()
    if (!(($machine -eq 0x8664 -and $magic -eq 0x20b) -or ($Kind -eq 'installer' -and $machine -eq 0x14c -and $magic -eq 0x10b))) { throw 'invalid' }
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class MusicMuteReleaseTrust {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct FileInfo {
  public uint size; [MarshalAs(UnmanagedType.LPWStr)] public string path; public IntPtr file,subject;
 }
 [StructLayout(LayoutKind.Sequential)] struct TrustData {
  public uint size; public IntPtr callback,sip; public uint ui,revocation,choice; public IntPtr data; public uint action; public IntPtr state,url; public uint flags,context; public IntPtr settings;
 }
 [DllImport("wintrust",ExactSpelling=true)] static extern int WinVerifyTrust(IntPtr window,ref Guid action,ref TrustData data);
 public static void Fresh(string path,IntPtr lockedFile) {
  FileInfo file=new FileInfo{size=(uint)Marshal.SizeOf(typeof(FileInfo)),path=path,file=lockedFile};
  IntPtr memory=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(FileInfo)));
  Guid policy=new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
  TrustData trust=new TrustData{size=(uint)Marshal.SizeOf(typeof(TrustData)),ui=2,revocation=1,choice=1,data=memory,action=1,flags=0x80|0x2000};
  try {Marshal.StructureToPtr(file,memory,false);if(WinVerifyTrust(new IntPtr(-1),ref policy,ref trust)!=0)throw new Exception("invalid");}
  finally {trust.action=2;WinVerifyTrust(new IntPtr(-1),ref policy,ref trust);Marshal.DestroyStructure(memory,typeof(FileInfo));Marshal.FreeHGlobal(memory);}
 }
}
public static class MusicMuteReleaseResources {
 [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr LoadLibraryEx(string name, IntPtr file, uint flags);
 [DllImport("kernel32", CharSet=CharSet.Unicode, EntryPoint="FindResourceW")] static extern IntPtr FindNumber(IntPtr module, IntPtr name, IntPtr type);
 [DllImport("kernel32", CharSet=CharSet.Unicode, EntryPoint="FindResourceW")] static extern IntPtr FindText(IntPtr module, string name, string type);
 [DllImport("kernel32")] static extern uint SizeofResource(IntPtr module, IntPtr resource);
 [DllImport("kernel32")] static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
 [DllImport("kernel32")] static extern IntPtr LockResource(IntPtr resource);
 [DllImport("kernel32")] static extern bool FreeLibrary(IntPtr module);
 public static string Read(string path, bool integrity) {
  IntPtr module=LoadLibraryEx(path,IntPtr.Zero,0x60);
  if(module==IntPtr.Zero) throw new Exception("invalid");
  try {
   IntPtr resource=integrity?FindText(module,"ElectronAsar","Integrity"):FindNumber(module,new IntPtr(1),new IntPtr(24));
   uint size=SizeofResource(module,resource);
   if(resource==IntPtr.Zero || size<1 || size>65536) throw new Exception("invalid");
   IntPtr data=LockResource(LoadResource(module,resource)); if(data==IntPtr.Zero)throw new Exception("invalid");
   byte[] bytes=new byte[size];Marshal.Copy(data,bytes,0,bytes.Length);
   return new UTF8Encoding(false,true).GetString(bytes);
  } finally {FreeLibrary(module);}
 }
}
'@
  # New package/installer approval explicitly retains whole-chain revocation
  # retrieval. Cache-only is solely a native already-approved installed check.
  [MusicMuteReleaseTrust]::Fresh($item.FullName,$stream.SafeFileHandle.DangerousGetHandle())
  $settings = New-Object Xml.XmlReaderSettings; $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
  $xmlReader = [Xml.XmlReader]::Create((New-Object IO.StringReader([MusicMuteReleaseResources]::Read($item.FullName,$false))),$settings)
  try { $xml = New-Object Xml.XmlDocument; $xml.Load($xmlReader) } finally { $xmlReader.Dispose() }
  $levels = $xml.SelectNodes("//*[local-name()='requestedExecutionLevel']")
  if ($levels.Count -ne 1 -or $levels[0].GetAttribute('level') -ne 'asInvoker' -or $levels[0].GetAttribute('uiAccess') -notin @('','false')) { throw 'invalid' }
  if ($AsarHeaderSha256) {
    if ($AsarHeaderSha256 -notmatch '^[a-f0-9]{64}$') { throw 'invalid' }
    $integrity = @([MusicMuteReleaseResources]::Read($item.FullName,$true) | ConvertFrom-Json)
    if ($integrity.Count -ne 1 -or $integrity[0].file -ne 'resources\app.asar' -or $integrity[0].alg -ne 'sha256' -or $integrity[0].value -ne $AsarHeaderSha256) { throw 'invalid' }
  }
  [Console]::Out.Write('{"verified":true}')
  } finally { $stream.Dispose() }
  exit 0
} catch {
  [Console]::Error.WriteLine('PACKAGE_SIGNATURE_INVALID')
  exit 2
}
