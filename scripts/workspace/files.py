"""Descriptor-anchored workspace filesystem operations.

Iterative, not recursive: a script can nest deeper than Python's stack. Every
entry operation is anchored to an open directory fd (O_NOFOLLOW), so a rename
mid-operation cannot redirect deletes outside the verified directory. A
permission-damaged child directory is healed via chmod by its owner before
descending, so `chmod 0` cannot wedge accounting or deletion. Only the current
path's ancestors stay open — directory fds open lazily one level at a time —
so depth is bounded by the launcher nofile limit, which a deep enough tree can
still exceed; that fails loudly and stays retryable, never silently partial.
"""
import hashlib
import json
import os
import stat
import sys

_DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def _open_child(fd, name):
    try:
        return os.open(name, _DIR_FLAGS, dir_fd=fd)
    except PermissionError:
        os.chmod(name, 0o700, dir_fd=fd)
        return os.open(name, _DIR_FLAGS, dir_fd=fd)


def _parts(path):
    if not path or path.startswith('/') or len(path) > 1024:
        raise ValueError('invalid_workspace_path')
    parts = path.split('/')
    if any(p in ('', '.', '..') for p in parts) or len(parts) > 64:
        raise ValueError('invalid_workspace_path')
    return parts


def _walk(fd, parts):
    """Open each directory component, anchored and symlink-free."""
    opened = []
    for name in parts:
        nxt = _open_child(fd, name)
        opened.append(nxt)
        fd = nxt
    return opened


def _walk_or_make(fd, parts):
    opened = []
    for name in parts:
        try:
            nxt = _open_child(fd, name)
        except FileNotFoundError:
            os.mkdir(name, 0o700, dir_fd=fd)
            nxt = os.open(name, _DIR_FLAGS, dir_fd=fd)
        opened.append(nxt)
        fd = nxt
    return opened


def _close_all(fds):
    for fd in reversed(fds):
        os.close(fd)


def _file_op(root_fd, op, path):
    parts = _parts(path)
    parents, leaf = parts[:-1], parts[-1]
    if op == 'write':
        fds = _walk_or_make(root_fd, parents)
        try:
            fd = os.open(leaf, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW,
                         0o600, dir_fd=fds[-1] if fds else root_fd)
            data = sys.stdin.buffer.read()
            digest = hashlib.sha256(data).hexdigest()
            with os.fdopen(fd, 'wb') as f:
                f.write(data)
            return {'bytes': len(data), 'sha256': digest}
        finally:
            _close_all(fds)
    fds = _walk(root_fd, parents)
    parent = fds[-1] if fds else root_fd
    try:
        if op == 'read':
            fd = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
            with os.fdopen(fd, 'rb') as f:
                data = f.read()
            # Header line carries the full digest/length; the body follows so a
            # truncated downstream capture still proves what the file was.
            sys.stdout.write(json.dumps({'bytes': len(data),
                                         'sha256': hashlib.sha256(data).hexdigest()}) + '\n')
            sys.stdout.flush()
            sys.stdout.buffer.write(data)
            return None
        if op == 'list':
            fd = os.open(leaf, _DIR_FLAGS, dir_fd=parent)
            entries = []
            with os.scandir(fd) as it:
                for entry in it:
                    info = entry.stat(follow_symlinks=False)
                    kind = ('dir' if stat.S_ISDIR(info.st_mode)
                            else 'link' if stat.S_ISLNK(info.st_mode) else 'file')
                    entries.append({'name': entry.name, 'kind': kind, 'size': info.st_size})
                    if len(entries) >= 2000:
                        break
            os.close(fd)
            entries.sort(key=lambda e: e['name'])
            return {'entries': entries, 'truncated': len(entries) >= 2000}
        if op == 'delete':
            try:
                fd = os.open(leaf, _DIR_FLAGS, dir_fd=parent)
            except OSError as e:
                if e.errno == 2:
                    raise  # ENOENT: nothing to delete
                # ENOTDIR/ELOOP: regular file or symlink — unlink removes the
                # name itself, never a followed target.
                os.unlink(leaf, dir_fd=parent)
                return {'removed': 'file'}
            remove(fd)
            os.close(fd)
            os.rmdir(leaf, dir_fd=parent)
            return {'removed': 'dir'}
        raise ValueError('invalid_workspace_operation')
    finally:
        _close_all(fds)


def _version():
    import platform
    import subprocess
    bash = subprocess.run(['/bin/bash', '--version'], capture_output=True, text=True)
    return {
        'python': platform.python_version(),
        'bash': bash.stdout.splitlines()[0] if bash.stdout else 'unknown',
    }


_SESSION_CAP = 64 * 1024 * 1024


def _exec_policed(runtime):
    """Interpreter wrapper that enforces the per-owner byte cap during the run.

    RLIMIT_FSIZE only bounds a single file; post-run accounting cannot undo an
    overshoot. This wrapper polls the anchored usage walk and kills the whole
    group the moment the cap is crossed, so one run can never exceed the
    session budget and have it measured only afterwards.
    """
    import subprocess
    import time
    cmd = ['/bin/bash', '--noprofile', '--norc', '-s'] if runtime == 'bash' else [
        '/usr/bin/python3', '-I', '-']
    root = os.open('.', _DIR_FLAGS)
    try:
        proc = subprocess.Popen(cmd)
        try:
            while proc.poll() is None:
                if usage(root) > _SESSION_CAP:
                    # The launcher placed us and the interpreter in one group;
                    # killing the group is what makes the breach stick even if
                    # the interpreter spawned helpers. We die with it — the C
                    # supervisor still owns cancel/reap.
                    sys.stderr.write('workspace_quota_exceeded\n')
                    sys.stderr.flush()
                    try:
                        os.killpg(os.getpgrp(), 9)
                    except (ProcessLookupError, PermissionError):
                        proc.kill()
                    return 99
                time.sleep(0.2)
            return proc.returncode
        finally:
            if proc.poll() is None:
                proc.kill()
    finally:
        os.close(root)


def usage(root_fd):
    total = 0
    stack = [{'fd': root_fd, 'children': None}]
    while stack:
        frame = stack[-1]
        if frame['children'] is None:
            children = []
            with os.scandir(frame['fd']) as entries:
                for entry in entries:
                    info = entry.stat(follow_symlinks=False)
                    total += info.st_size
                    if stat.S_ISDIR(info.st_mode):
                        children.append(entry.name)
            frame['children'] = children
        if not frame['children']:
            if frame['fd'] != root_fd:
                os.close(frame['fd'])
            stack.pop()
            continue
        stack.append({'fd': _open_child(frame['fd'], frame['children'].pop()), 'children': None})
    return total


def remove(root_fd):
    """Empty the directory anchored at root_fd, deepest first."""
    stack = [{'fd': root_fd, 'name': None, 'parent_fd': None, 'children': None}]
    while stack:
        frame = stack[-1]
        if frame['children'] is None:
            children = []
            with os.scandir(frame['fd']) as entries:
                for entry in entries:
                    if stat.S_ISDIR(entry.stat(follow_symlinks=False).st_mode):
                        children.append(entry.name)
                    else:
                        os.unlink(entry.name, dir_fd=frame['fd'])
            frame['children'] = children
        if not frame['children']:
            if frame['parent_fd'] is not None:
                os.rmdir(frame['name'], dir_fd=frame['parent_fd'])
                os.close(frame['fd'])
            stack.pop()
            continue
        name = frame['children'].pop()
        child = _open_child(frame['fd'], name)
        stack.append({'fd': child, 'name': name, 'parent_fd': frame['fd'], 'children': None})


if sys.argv[1] == 'usage':
    root = os.open('.', _DIR_FLAGS)
    try:
        print(json.dumps({'bytes': usage(root)}))
    finally:
        os.close(root)
elif sys.argv[1] == 'remove':
    # cwd is the verified workspace dir (the launcher fchdir'd into it); the
    # name rmdir happens under its real parent so the inode we emptied is the
    # inode removed. The pool root is group write+execute only — O_PATH, not
    # O_RDONLY, is the fd that survives without read permission.
    root = os.open('.', _DIR_FLAGS)
    parent = os.open('..', os.O_PATH | os.O_NOFOLLOW)
    try:
        remove(root)
        os.rmdir(sys.argv[2], dir_fd=parent)
    finally:
        os.close(root)
        os.close(parent)
elif sys.argv[1] == 'version':
    print(json.dumps(_version()))
elif sys.argv[1] == 'file':
    root = os.open('.', _DIR_FLAGS)
    try:
        result = _file_op(root, sys.argv[2], sys.argv[3])
        if result is not None:
            print(json.dumps(result))
    finally:
        os.close(root)
elif sys.argv[1] == 'exec':
    sys.exit(_exec_policed(sys.argv[2]))
else:
    raise ValueError('invalid_workspace_operation')
