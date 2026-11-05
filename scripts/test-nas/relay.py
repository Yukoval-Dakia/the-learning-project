#!/usr/bin/env python3
# Local ports to NAS TEST. The NAS sshd forbids TCP forwarding, so each connection is an ssh exec channel running nc.
# Ports stay bound to 127.0.0.1 on both ends. A port that fails to bind retries alone while the others keep serving
# (5544 exists only as the fallback for a stuck 5433, so the ports must not share one fate). A channel can fail while
# multiplexing starts or at sshd's limit of 10 sessions per connection, so the client's bytes are read only after the
# remote side confirms it is up, and a failed setup retries safely on another multiplexed connection.
import asyncio, itertools, os, sys
HOME = os.path.expanduser('~')
MASTERS = 6
ATTEMPTS = 8
counter = itertools.count()
def ssh_args(n):
    return ['/usr/bin/ssh', '-F', 'none', '-i', f'{HOME}/.ssh/tlp_nas_ed25519', '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
            '-o', 'ControlMaster=auto', '-o', f'ControlPath={HOME}/.ssh/cm-tlp-nas-{n}', '-o', 'ControlPersist=600',
            '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-o', 'LogLevel=ERROR', 'yukoval@bancho-nb2.local']
PORTS = {8787: 18787, 5433: 15433, 5544: 15433}
READY = b'R'

async def pump(reader, writer, close):
    try:
        while True:
            b = await reader.read(65536)
            if not b:
                break
            writer.write(b)
            await writer.drain()
    except (ConnectionError, BrokenPipeError):
        pass
    finally:
        close()

async def open_channel(remote_port):
    for attempt in range(ATTEMPTS):
        n = next(counter) % MASTERS
        p = await asyncio.create_subprocess_exec(*ssh_args(n), f"printf {READY.decode()}; exec nc -N 127.0.0.1 {remote_port}",
                                                 stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        try:
            first = await asyncio.wait_for(p.stdout.readexactly(1), 20)
            if first == READY:
                return p
        except (asyncio.IncompleteReadError, asyncio.TimeoutError):
            pass
        try:
            p.kill()
        except ProcessLookupError:
            pass
        await p.wait()
        print(f'channel setup failed, attempt {attempt + 1}, port {remote_port}', file=sys.stderr, flush=True)
        await asyncio.sleep(0.1 * (attempt + 1))
    return None

def handler(remote_port):
    async def handle(client_r, client_w):
        p = await open_channel(remote_port)
        if p is None:
            print(f'channel setup gave up, port {remote_port}', file=sys.stderr, flush=True)
            client_w.close()
            return
        def close_stdin():
            if p.stdin and not p.stdin.is_closing():
                p.stdin.close()
        await asyncio.gather(pump(client_r, p.stdin, close_stdin), pump(p.stdout, client_w, client_w.close))
        try:
            p.terminate()
        except ProcessLookupError:
            pass
        await p.wait()
    return handle

BIND_RETRY = 30

async def bind_port(local, remote):
    while True:
        try:
            await asyncio.start_server(handler(remote), '127.0.0.1', local, backlog=256)
            return
        except OSError as e:
            print(f'bind 127.0.0.1:{local} failed ({e}), retry in {BIND_RETRY}s', file=sys.stderr, flush=True)
            await asyncio.sleep(BIND_RETRY)

async def main():
    await asyncio.gather(*(bind_port(local, remote) for local, remote in PORTS.items()))
    await asyncio.Event().wait()

asyncio.run(main())
