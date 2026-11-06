#!/usr/bin/env python3
# Local port 8787 to the NAS TEST app. The NAS sshd forbids TCP forwarding, so each connection is an ssh exec channel
# running a small forwarder. Ports stay bound to 127.0.0.1 on both ends; no local port may reach TEST's Postgres, query it
# with ssh + docker exec instead. A channel can fail while multiplexing starts or at sshd's limit of 10 sessions per
# connection, so the client's bytes are read only after the remote side confirms it is up, and a failed setup retries
# safely on another multiplexed connection. Channels stay parked and ready, so a request normally skips the ssh setup.
# Every request gets its own connection; see forward_first_request.
import asyncio, collections, itertools, os, sys, time
HOME = os.path.expanduser('~')
# Which local process opened each connection, and how many bytes moved. Never content, headers or tokens.
CONN_LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'connections.log')
CONN_LOG_MAX = 20 * 1024 * 1024
STALL_S = 20
conn_ids = itertools.count(1)
MASTERS = 6
ATTEMPTS = 8
ATTEMPT_TIMEOUT = 5
POOL_SIZE = 8
MAX_HEAD = 1024 * 1024
POOL_MAX_AGE = 300
active = [0] * MASTERS
# Runs on the NAS in place of nc. OpenBSD nc keeps waiting on stdin after the server closes, so the close never reached
# the browser: a keep-alive connection idle past the app's 5 s timeout hung on its next request. This exits on server EOF.
FORWARDER = '''
import os, select, socket
s = socket.create_connection(("127.0.0.1", %d))
s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
rd = [0, s]
while True:
    r = select.select(rd, [], [])[0]
    if s in r:
        d = s.recv(65536)
        if not d:
            break
        while d:
            d = d[os.write(1, d):]
    if 0 in r:
        d = os.read(0, 65536)
        if d:
            s.sendall(d)
        else:
            s.shutdown(socket.SHUT_WR)
            rd.remove(0)
'''
def log(msg):
    print(f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} {msg}", file=sys.stderr, flush=True)
def ssh_args(n):
    return ['/usr/bin/ssh', '-F', 'none', '-i', f'{HOME}/.ssh/tlp_nas_ed25519', '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
            '-o', 'ControlMaster=auto', '-o', f'ControlPath={HOME}/.ssh/cm-tlp-nas-{n}', '-o', 'ControlPersist=600',
            '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-o', 'LogLevel=ERROR', 'yukoval@bancho-nb2.local']
# Only the app. Query TEST with ssh + docker exec; dev scripts must not be able to reach its database.
PORTS = {8787: 18787}
READY = b'R'
failed_masters = set()
GO = b'G'
pools = {}

def conn_log(msg):
    try:
        if os.path.exists(CONN_LOG) and os.path.getsize(CONN_LOG) > CONN_LOG_MAX:
            os.replace(CONN_LOG, CONN_LOG + '.1')
        fd = os.open(CONN_LOG, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        with os.fdopen(fd, 'a') as f:
            f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} {msg}\n")
    except OSError as e:
        log(f'connection log failed: {e}')

async def conn_owner(cid, peer_port):
    """Runs beside the connection, so a slow lsof never delays a request."""
    who = 'unknown'
    try:
        async with lsof_slots:
            p = await asyncio.create_subprocess_exec('/usr/sbin/lsof', '-nP', f'-iTCP@127.0.0.1:{peer_port}', '-Fpc',
                                                     stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
            out, _ = await asyncio.wait_for(p.communicate(), 5)
        pid = None
        for line in out.decode(errors='replace').splitlines():
            if line.startswith('p'):
                pid = line[1:]
            elif line.startswith('c') and pid and int(pid) != os.getpid():
                who = f'pid={pid} name={line[1:]}'
                break
    except (OSError, ValueError, asyncio.TimeoutError):
        pass
    conn_log(f'conn={cid} open port={peer_port} {who}')

class Traffic:
    def __init__(self):
        self.up = self.down = 0
        self.last_up = self.last_down = 0.0

async def watch_stall(cid, t, master):
    """A request sent with no bytes back for STALL_S is what a browser sees as a hang; say so once per request."""
    warned = 0.0
    while True:
        await asyncio.sleep(5)
        if t.last_up > t.last_down and t.last_up != warned and time.monotonic() - t.last_up > STALL_S:
            warned = t.last_up
            conn_log(f'conn={cid} stall master={master} no response {time.monotonic() - t.last_up:.0f}s up={t.up} down={t.down}')

async def pump(reader, writer, close, count=None):
    try:
        while True:
            b = await reader.read(65536)
            if not b:
                break
            if count:
                count(len(b))
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

async def spawn(remote_port, avoid=frozenset()):
    """A channel parked on the NAS: up and confirmed, but the forwarder starts only once it is activated."""
    n = min((i for i in range(MASTERS) if i not in avoid), key=lambda i: active[i])
    active[n] += 1
    failed_masters.discard(n)
    p = await asyncio.create_subprocess_exec(*ssh_args(n), f"printf {READY.decode()}; read _; printf {GO.decode()}; exec python3 -I -c '{FORWARDER % remote_port}'",
                                             stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    p.master = n
    asyncio.create_task(track(p, n))
    try:
        if await asyncio.wait_for(p.stdout.readexactly(1), ATTEMPT_TIMEOUT) == READY:
            return p
    except (asyncio.IncompleteReadError, asyncio.TimeoutError):
        pass
    failed_masters.add(n)
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
    avoid = set()
    for attempt in range(ATTEMPTS):
        warm = bool(pool)
        p = pool.popleft()[1] if warm else await spawn(remote_port, frozenset(avoid))
        if p is None:
            avoid |= failed_masters
        elif await activate(p):
            took = time.monotonic() - t0
            if took > 1:
                log(f'slow channel {took:.1f}s, attempts {attempt + 1}, port {remote_port}')
            return p
        else:
            avoid.add(p.master)
        if len(avoid) >= MASTERS:
            avoid.clear()
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
            p = await spawn(remote_port, frozenset(failed_masters) if len(failed_masters) < MASTERS else frozenset())
            if p is None:
                log(f'warm channel failed, port {remote_port}, failed masters {sorted(failed_masters)}')
                await asyncio.sleep(5)
            else:
                failed_masters.clear()
                pool.append((time.monotonic(), p))
            continue
        await asyncio.sleep(1)

async def forward_first_request(reader, writer, count):
    """One request per connection. A close from the app reaches the client only after a trip through ssh, so a client
    reusing an idle connection could send into one already closed: it waited, got ERR_CONNECTION_CLOSED, and retried on the
    next stale one. Asking for Connection: close removes idle connections altogether. Upgrades pass through unchanged."""
    buf = b''
    try:
        while b'\r\n\r\n' not in buf and len(buf) < MAX_HEAD:
            b = await reader.read(65536)
            if not b:
                break
            count(len(b))
            buf += b
        head, sep, rest = buf.partition(b'\r\n\r\n')
        lines = head.split(b'\r\n')
        if sep and not any(l.lower().startswith(b'upgrade:') for l in lines):
            kept = [l for l in lines if not l.lower().startswith((b'connection:', b'keep-alive:'))]
            buf = b'\r\n'.join(kept + [b'Connection: close']) + sep + rest
        if buf:
            writer.write(buf)
            await writer.drain()
    except (ConnectionError, BrokenPipeError):
        pass

def handler(remote_port):
    async def handle(client_r, client_w):
        cid = next(conn_ids)
        t0 = time.monotonic()
        asyncio.create_task(conn_owner(cid, client_w.get_extra_info('peername')[1]))
        p = await open_channel(remote_port)
        if p is None:
            log(f'channel setup gave up, port {remote_port}')
            conn_log(f'conn={cid} refused channel setup gave up')
            client_w.close()
            return
        conn_log(f'conn={cid} channel master={p.master} after={time.monotonic() - t0:.2f}s')
        t = Traffic()
        def up(n):
            t.up += n
            t.last_up = time.monotonic()
        def down(n):
            t.down += n
            t.last_down = time.monotonic()
        stall = asyncio.create_task(watch_stall(cid, t, p.master))
        def close_stdin():
            if p.stdin and not p.stdin.is_closing():
                p.stdin.close()
        async def client_to_app():
            await forward_first_request(client_r, p.stdin, up)
            await pump(client_r, p.stdin, close_stdin, up)
        await asyncio.gather(client_to_app(), pump(p.stdout, client_w, client_w.close, down))
        stall.cancel()
        conn_log(f'conn={cid} close secs={time.monotonic() - t0:.1f} up={t.up} down={t.down}')
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
    global lsof_slots
    lsof_slots = asyncio.Semaphore(4)
    log('relay started')
    for remote in PORTS.values():
        pools[remote] = collections.deque()
        asyncio.create_task(keep_warm(remote))
    await asyncio.gather(*(bind_port(local, remote) for local, remote in PORTS.items()))
    await asyncio.Event().wait()

asyncio.run(main())
