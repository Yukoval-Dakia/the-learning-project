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
else:
    raise ValueError('invalid_workspace_operation')
