"""Descriptor-anchored byte accounting for one workspace directory."""
import json
import os
import stat
import sys


def usage(path):
    total = 0
    with os.scandir(path) as entries:
        for entry in entries:
            info = entry.stat(follow_symlinks=False)
            total += info.st_size
            if stat.S_ISDIR(info.st_mode):
                fd = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=path)
                try:
                    total += usage(fd)
                finally:
                    os.close(fd)
    return total


if sys.argv[1] == 'usage':
    root = os.open('.', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        print(json.dumps({'bytes': usage(root)}))
    finally:
        os.close(root)
else:
    raise ValueError('invalid_workspace_operation')
