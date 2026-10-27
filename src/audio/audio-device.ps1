$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorComObject { }

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
    int OpenPropertyStore(int stgmAccess, out IntPtr ppProperties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
    int GetState(out int pdwState);
}

[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr pNotify);
    int UnregisterControlChangeNotify(IntPtr pNotify);
    int GetChannelCount(out int pnChannelCount);
    int SetMasterVolumeLevel(float fLevelDB, ref Guid pguidEventContext);
    int SetMasterVolumeLevelScalar(float fLevel, ref Guid pguidEventContext);
    int GetMasterVolumeLevel(out float pfLevelDB);
    int GetMasterVolumeLevelScalar(out float pfLevel);
    int SetChannelVolumeLevel(uint nChannel, float fLevelDB, ref Guid pguidEventContext);
    int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, ref Guid pguidEventContext);
    int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
    int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
    int SetMute(bool bMute, ref Guid pguidEventContext);
    int GetMute(out bool pbMute);
}

public static class AudioEndpoint {
    const int eRender = 0;
    const int CLSCTX_ALL = 23;
    const int DEVICE_STATE_ACTIVE = 1;

    public static string Get(int role) {
        try {
            var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
            IMMDevice device;
            int hr = enumerator.GetDefaultAudioEndpoint(eRender, role, out device);
            if (hr != 0) return "{\"ok\":false,\"role\":" + role + ",\"error\":\"NO_OUTPUT_DEVICE\",\"hr\":" + hr + "}";
            int state;
            device.GetState(out state);
            var iid = typeof(IAudioEndpointVolume).GUID;
            object obj;
            hr = device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out obj);
            if (hr != 0) return "{\"ok\":false,\"role\":" + role + ",\"error\":\"ACTIVATE_FAILED\",\"hr\":" + hr + "}";
            var volume = (IAudioEndpointVolume)obj;
            bool muted = false;
            float level = -1;
            volume.GetMute(out muted);
            volume.GetMasterVolumeLevelScalar(out level);
            string id = "";
            device.GetId(out id);
            var safeId = (id ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"");
            return "{\"ok\":true,\"role\":" + role
                + ",\"muted\":" + (muted ? "true" : "false")
                + ",\"volume\":" + level.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture)
                + ",\"state\":" + state
                + ",\"active\":" + ((state & DEVICE_STATE_ACTIVE) != 0 ? "true" : "false")
                + ",\"endpointId\":\"" + safeId + "\"}";
        } catch (Exception ex) {
            var message = ex.Message.Replace("\\", "\\\\").Replace("\"", "\\\"");
            return "{\"ok\":false,\"role\":" + role + ",\"error\":\"" + message + "\"}";
        }
    }
}
'@

$roleNames = @{ 0 = 'console'; 1 = 'multimedia'; 2 = 'communications' }
$roles = [ordered]@{}
foreach ($role in 0, 1, 2) {
    $roles[$roleNames[$role]] = ([AudioEndpoint]::Get($role) | ConvertFrom-Json)
}

$primary = $roles['console']
$anyMuted = $false
$anyVolumeZero = $false
foreach ($name in $roles.Keys) {
    $entry = $roles[$name]
    if ($entry.ok) {
        if ($entry.muted) { $anyMuted = $true }
        if ([double]$entry.volume -lt 0.01) { $anyVolumeZero = $true }
    }
}

if (-not $deviceName) {
    try {
        $deviceName = (Get-CimInstance Win32_SoundDevice -ErrorAction SilentlyContinue |
            Where-Object { $_.Status -eq 'OK' } |
            Select-Object -First 1 -ExpandProperty Name)
    } catch {}
}

$out = [ordered]@{
    ok             = [bool]$primary.ok
    muted          = if ($primary.ok) { [bool]$primary.muted } else { $false }
    volume         = if ($primary.ok) { [double]$primary.volume } else { -1 }
    active         = if ($primary.ok) { [bool]$primary.active } else { $false }
    endpointId     = if ($primary.ok) { $primary.endpointId } else { '' }
    deviceName     = [string]$deviceName
    anyMuted       = $anyMuted
    anyVolumeZero  = $anyVolumeZero
    roles          = $roles
}
$out | ConvertTo-Json -Compress -Depth 6
