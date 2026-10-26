"""Locate the WeChat mini-program host and its network-owning parent process."""
import json
import os
import subprocess

PS_QUERY = (
    "@(Get-CimInstance Win32_Process -Filter \"Name = 'WeChatAppEx.exe'\" | "
    "Where-Object { $_.CommandLine -like '*--utility-sub-type=flue.mojom.ILinkServiceHost*' } | "
    "Select-Object ProcessId,ParentProcessId) | ConvertTo-Json -Compress"
)


def require_windows():
    if os.name != 'nt':
        raise RuntimeError('CAPTURE_REQUIRES_WINDOWS')


def host_processes():
    """Return [{pid, hostPid}] for open mini-program login hosts."""
    require_windows()
    try:
        result = subprocess.run(
            ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', PS_QUERY],
            capture_output=True, text=True, check=True, timeout=20,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise RuntimeError('CAPTURE_PROCESS_QUERY_FAILED') from error
    raw = result.stdout.strip()
    hosts = json.loads(raw) if raw else []
    if isinstance(hosts, dict):
        hosts = [hosts]
    found = []
    for host in hosts:
        try:
            found.append({'pid': int(host['ProcessId']), 'hostPid': int(host['ParentProcessId'])})
        except (KeyError, TypeError, ValueError):
            continue
    return found


def select_host(pid=None, host_pid=None):
    """Pick exactly one host; returns (login_pid, network_pid)."""
    hosts = host_processes()
    if pid is not None:
        hosts = [host for host in hosts if host['pid'] == pid]
    if host_pid is not None:
        hosts = [host for host in hosts if host['hostPid'] == host_pid]
    if not hosts:
        raise RuntimeError('OPEN_TARGET_MINIPROGRAM_FIRST')
    if len(hosts) > 1:
        raise RuntimeError('MULTIPLE_HOSTS: ' + json.dumps(hosts))
    return hosts[0]['pid'], hosts[0]['hostPid']
