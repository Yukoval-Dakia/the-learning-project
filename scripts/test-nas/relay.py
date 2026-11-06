#!/usr/bin/env python3
# Local port 8787 to the NAS TEST app. The NAS sshd forbids TCP forwarding, so each connection is an ssh exec
# channel running nc. Ports stay bound to 127.0.0.1 on both ends. The former database relays (5433/5544 -> NAS
# 15433) were closed on 2026-11-06: dev scripts used to default to 5433, so no local port may reach TEST's
# Postgres — query TEST with ssh + docker exec instead (see PORTS below). A channel can fail while multiplexing
# starts or at sshd's limit of 10 sessions per connection, so the client's bytes are read only after the remote
# side confirms it is up, and a failed setup retries safely on another multiplexed connection. A few channels
# stay parked and ready, so a request normally skips the ssh setup.
import asyncio, collections, os, sys, time
HOME = os.path.expanduser('~')
MASTERS = 6
ATTEMPTS = 8
ATTEMPT_TIMEOUT = 5
POOL_SIZE = 3
POOL_MAX_AGE = 300
active = [0] * MASTERS
def log(msg):
    print(f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} {msg}", file=sys.stderr, flush=True)
def ssh_args(n):
    return ['/usr/bin/ssh', '-F', 'none', '-i', f'{HOME}/.ssh/tlp_nas_ed25519', '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
            '-o', 'ControlMaster=auto', '-o', f'ControlPath={HOME}/.ssh/cm-tlp-nas-{n}', '-o', 'ControlPersist=600',
            '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-o', 'LogLevel=ERROR', 'yukoval@bancho-nb2.local']
# Database ports closed 2026-11-06: dev scripts default to 5433, so it must not reach TEST. Query TEST with ssh + docker exec.
PORTS = {8787: 18787}
READY = b'R'
GO = b'G'
pools = {}

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

async def kill(p):
    try:
        p.kill()
    except ProcessLookupError:
        pass
    await p.wait()

async def track(p, n):
    await p.wait()
    active[n] -= 1

async def spawn(remote_port):
    """A channel parked on the NAS: up and confirmed, but nc starts only once it is activated."""
    n = min(range(MASTERS), key=lambda i: active[i])
    active[n] += 1
    p = await asyncio.create_subprocess_exec(*ssh_args(n), f"printf {READY.decode()}; read _; printf {GO.decode()}; exec nc -N 127.0.0.1 {remote_port}",
                                             stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    asyncio.create_task(track(p, n))
    try:
        if await asyncio.wait_for(p.stdout.readexactly(1), ATTEMPT_TIMEOUT) == READY:
            return p
    except (asyncio.IncompleteReadError, asyncio.TimeoutError):
        pass
    await kill(p)
    return None

async def activate(p):
    """The client's bytes are read only after this, so a dead channel retries safely."""
    if p.returncode is not None:
        return False
    try:
        p.stdin.write(b'\n')
        await p.stdin.drain()
        if await asyncio.wait_for(p.stdout.readexactly(1), ATTEMPT_TIMEOUT) == GO:
            return True
    except (asyncio.IncompleteReadError, asyncio.TimeoutError, ConnectionError, BrokenPipeError):
        pass
    await kill(p)
    return False

async def open_channel(remote_port):
    pool = pools[remote_port]
    t0 = time.monotonic()
    for attempt in range(ATTEMPTS):
        warm = bool(pool)
        p = pool.popleft()[1] if warm else await spawn(remote_port)
        if p is not None and await activate(p):
            took = time.monotonic() - t0
            if took > 1:
                log(f'slow channel {took:.1f}s, attempts {attempt + 1}, port {remote_port}')
            return p
        log(f"channel setup failed, attempt {attempt + 1}, {'warm' if warm else 'new'}, port {remote_port}, {time.monotonic() - t0:.1f}s")
        await asyncio.sleep(0.05 * (attempt + 1))
    return None

async def keep_warm(remote_port):
    pool = pools[remote_port]
    while True:
        while pool and (pool[0][1].returncode is not None or time.monotonic() - pool[0][0] > POOL_MAX_AGE):
            _, old = pool.popleft()
            if old.returncode is None:
                await kill(old)
        if len(pool) < POOL_SIZE:
            p = await spawn(remote_port)
            if p is None:
                log(f'warm channel failed, port {remote_port}')
                await asyncio.sleep(5)
            else:
                pool.append((time.monotonic(), p))
            continue
        await asyncio.sleep(1)

def handler(remote_port):
    async def handle(client_r, client_w):
        p = await open_channel(remote_port)
        if p is None:
            log(f'channel setup gave up, port {remote_port}')
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
            log(f'bind 127.0.0.1:{local} failed ({e}), retry in {BIND_RETRY}s')
            await asyncio.sleep(BIND_RETRY)

async def main():
    log('relay started')
    for remote in PORTS.values():
        pools[remote] = collections.deque()
        asyncio.create_task(keep_warm(remote))
    await asyncio.gather(*(bind_port(local, remote) for local, remote in PORTS.items()))
    await asyncio.Event().wait()

asyncio.run(main())
