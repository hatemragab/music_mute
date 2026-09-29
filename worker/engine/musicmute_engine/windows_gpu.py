"""DXGI adapter identity for the same ordinal selected by ONNX DirectML."""
from __future__ import annotations

import ctypes
import json
import sys
import uuid


class Guid(ctypes.Structure):
    _fields_ = [("data1", ctypes.c_uint32), ("data2", ctypes.c_uint16),
                ("data3", ctypes.c_uint16), ("data4", ctypes.c_ubyte * 8)]


class Luid(ctypes.Structure):
    _fields_ = [("low", ctypes.c_uint32), ("high", ctypes.c_int32)]


class AdapterDescription(ctypes.Structure):
    _fields_ = [("description", ctypes.c_wchar * 128),
                ("vendor_id", ctypes.c_uint32), ("device_id", ctypes.c_uint32),
                ("subsystem_id", ctypes.c_uint32), ("revision", ctypes.c_uint32),
                ("dedicated_video_memory", ctypes.c_size_t),
                ("dedicated_system_memory", ctypes.c_size_t),
                ("shared_system_memory", ctypes.c_size_t),
                ("luid", Luid), ("flags", ctypes.c_uint32)]


def _method(instance, index, result, *arguments):
    table = ctypes.cast(instance, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    return ctypes.WINFUNCTYPE(result, ctypes.c_void_p, *arguments)(table[index])


def adapter_identity(index: int = 0) -> dict[str, object]:
    if sys.platform != "win32" or index != 0:
        raise OSError("Qualified DirectML identity requires Windows adapter 0")
    dxgi = ctypes.WinDLL("dxgi.dll", winmode=0x00000800)
    create = dxgi.CreateDXGIFactory1
    create.argtypes = [ctypes.POINTER(Guid), ctypes.POINTER(ctypes.c_void_p)]
    create.restype = ctypes.c_int32
    iid = Guid.from_buffer_copy(uuid.UUID("770aae78-f26f-4dba-a829-253c83d1b387").bytes_le)
    factory, adapter = ctypes.c_void_p(), ctypes.c_void_p()
    if create(ctypes.byref(iid), ctypes.byref(factory)) < 0 or not factory:
        raise OSError("DXGI factory creation failed")
    try:
        enumerate_adapter = _method(factory, 12, ctypes.c_int32, ctypes.c_uint32, ctypes.POINTER(ctypes.c_void_p))
        if enumerate_adapter(factory, index, ctypes.byref(adapter)) < 0 or not adapter:
            raise OSError("DXGI adapter is unavailable")
        try:
            description = AdapterDescription()
            get_description = _method(adapter, 10, ctypes.c_int32, ctypes.POINTER(AdapterDescription))
            if get_description(adapter, ctypes.byref(description)) < 0:
                raise OSError("DXGI adapter description failed")
            if description.flags & 2 or not description.vendor_id:
                raise OSError("DirectML adapter must be hardware")
            name = description.description.strip()
            if not name or any(ord(character) < 32 for character in name):
                raise OSError("DXGI adapter name is invalid")
            # Query IDXGIDevice, not a D3D11/12 interface. WDDM 2.3+ requires
            # the D3D driver components in a package to share this version.
            device_iid = Guid.from_buffer_copy(uuid.UUID("54ec77fa-1377-44e6-8c32-88fd5f44c84c").bytes_le)
            driver = ctypes.c_int64()
            check_driver = _method(adapter, 9, ctypes.c_int32, ctypes.POINTER(Guid), ctypes.POINTER(ctypes.c_int64))
            if check_driver(adapter, ctypes.byref(device_iid), ctypes.byref(driver)) < 0 or driver.value <= 0:
                raise OSError("DXGI adapter driver version is unavailable")
            driver_version = ".".join(str((driver.value >> shift) & 0xffff) for shift in (48, 32, 16, 0))
            return {
                "source": "DXGI EnumAdapters1/GetDesc1", "deviceIndex": index,
                "name": name, "vendorId": description.vendor_id,
                "deviceId": description.device_id, "subsystemId": description.subsystem_id,
                "revision": description.revision,
                "driverVersion": driver_version,
                "luid": f"{description.luid.high & 0xffffffff:08x}{description.luid.low:08x}",
                "dedicatedVideoMemoryBytes": description.dedicated_video_memory,
                "sharedSystemMemoryLimitBytes": description.shared_system_memory,
            }
        finally:
            _method(adapter, 2, ctypes.c_uint32)(adapter)
    finally:
        _method(factory, 2, ctypes.c_uint32)(factory)


if __name__ == "__main__":
    print(json.dumps(adapter_identity(), sort_keys=True))
