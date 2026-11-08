#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/capability.h>
#include <stdio.h>
#include <signal.h>
#include <sys/wait.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#define ROOT "/var/lib/tlp/workspaces"
#define UID 29082

static void fail(const char *operation) {
    perror(operation);
    exit(125);
}

static volatile sig_atomic_t cancelled = 0;
static void cancel(int signo) { (void)signo; cancelled = 1; }

static void drop(void) {
    if (setgroups(0, NULL) || setresgid(UID, UID, UID) || setresuid(UID, UID, UID)) fail("identity");
    struct __user_cap_header_struct header = { _LINUX_CAPABILITY_VERSION_3, 0 };
    struct __user_cap_data_struct caps[2] = {{0}, {0}};
    if (syscall(SYS_capset, &header, caps) ||
        prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) ||
        prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) fail("capabilities");
}

// File paths are argv-carried untrusted input; validate them in C too so a bad
// shape dies before any filesystem reach. Python re-validates anchored, but
// the C gate keeps the failure cheap and uniform.
static int valid_path(const char *p) {
    size_t n = strlen(p);
    if (n == 0 || n > 1024 || p[0] == '/' || p[n - 1] == '/') return 0;
    int seg = 0;
    for (size_t i = 0; i <= n; i++) {
        if (i == n || p[i] == '/') {
            if (seg == 0) return 0;
            if (seg == 1 && p[i - 1] == '.') return 0;
            if (seg == 2 && p[i - 1] == '.' && p[i - 2] == '.') return 0;
            seg = 0;
        } else {
            unsigned char c = (unsigned char)p[i];
            if (c < 0x20 || c == 0x7f) return 0;
            seg++;
        }
    }
    return 1;
}

int main(int argc, char **argv) {
    if (argc < 3 || argc > 5 || strlen(argv[2]) != 64) return 125;
    for (const char *p = argv[2]; *p; p++)
        if (!(*p >= '0' && *p <= '9') && !(*p >= 'a' && *p <= 'f')) return 125;
    if (strcmp(argv[1], "create") && strcmp(argv[1], "remove") &&
        strcmp(argv[1], "bash") && strcmp(argv[1], "python") &&
        strcmp(argv[1], "usage") && strcmp(argv[1], "files") &&
        strcmp(argv[1], "version")) return 125;
    if ((!strcmp(argv[1], "files") && argc != 5) ||
        (strcmp(argv[1], "files") && argc != 3)) return 125;
    if (!strcmp(argv[1], "files") &&
        ((strcmp(argv[3], "read") && strcmp(argv[3], "write") &&
          strcmp(argv[3], "list") && strcmp(argv[3], "delete")) ||
         !valid_path(argv[4]))) return 125;

    // A node-identity supervisor is cancellable by the worker. It never executes
    // caller code; after wait/cancel it drops to the sandbox identity to reap the group.
    if (!strcmp(argv[1], "bash") || !strcmp(argv[1], "python")) {
        struct sigaction sa = {0};
        sa.sa_handler = cancel;
        sigemptyset(&sa.sa_mask);
        if (sigaction(SIGTERM, &sa, NULL) || sigaction(SIGINT, &sa, NULL)) fail("signal");
        pid_t child = fork();
        if (child < 0) fail("fork");
        if (child > 0) {
            if (setpgid(child, child) && errno != EACCES && errno != ESRCH) fail("group");
            int status = 0;
            while (!cancelled) {
                if (waitpid(child, &status, 0) >= 0) break;
                if (errno != EINTR) fail("wait");
            }
            drop();
            kill(-child, SIGKILL);
            if (cancelled) { while (waitpid(child, &status, 0) < 0 && errno == EINTR) {} }
            return cancelled ? 124 : WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
        }
        if (setpgid(0, 0)) fail("group");
        signal(SIGTERM, SIG_DFL);
        signal(SIGINT, SIG_DFL);
    }
    drop();
    if (syscall(SYS_close_range, 3, ~0U, 0)) fail("close_range");
    umask(0077);
    if (chdir(ROOT)) fail("root");
    if (!strcmp(argv[1], "create")) {
        if (mkdir(argv[2], 0700) && errno != EEXIST) fail("mkdir");
        return 0;
    }
    if (!strcmp(argv[1], "version")) {
        // Runtime provenance for scoring evidence; needs no workspace dir, so
        // it runs before the open/fstat block. Same identity, same image.
        char *args[] = {"/usr/bin/python3", "-I", "/usr/local/libexec/workspace-files.py",
            argv[1], NULL};
        char *env[] = {"PATH=/usr/bin:/bin", "LANG=C.UTF-8", NULL};
        execve(args[0], args, env);
        fail("version");
    }
    int dir = open(argv[2], O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    if (dir < 0) {
        if (errno == ENOENT && !strcmp(argv[1], "remove")) return 0;
        // A script can chmod its own workspace to 0 to dodge accounting. The
        // sandbox identity owns the directory, so heal the mode and retry once
        // instead of letting one owner wedge quota or deletion for everyone.
        if (errno != EACCES || chmod(argv[2], 0700)) fail("directory");
        dir = open(argv[2], O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
        if (dir < 0) fail("directory");
    }
    struct stat st;
    if (fstat(dir, &st) || st.st_uid != UID || (st.st_mode & 077) != 0) return 125;
    if (!strcmp(argv[1], "remove")) {
        // The fd pins the verified inode: empty it, then rmdir the name under
        // its parent. Deleting by path after close would let a rename swap a
        // different directory into the path mid-delete.
        if (fchdir(dir)) fail("cwd");
        char *args[] = {"/usr/bin/python3", "-I", "/usr/local/libexec/workspace-files.py",
            argv[1], argv[2], NULL};
        char *env[] = {"PATH=/usr/bin:/bin", "LANG=C.UTF-8", NULL};
        execve(args[0], args, env);
        fail("remove");
    }
    if (fchdir(dir)) fail("cwd");
    close(dir);
    if (!strcmp(argv[1], "usage")) {
        char *args[] = {"/usr/bin/python3", "-I", "/usr/local/libexec/workspace-files.py", argv[1], NULL};
        char *env[] = {"PATH=/usr/bin:/bin", "LANG=C.UTF-8", NULL};
        execve(args[0], args, env);
        fail("usage");
    }
    struct rlimit size = {64 * 1024 * 1024, 64 * 1024 * 1024};
    struct rlimit procs = {64, 64};
    struct rlimit core = {0, 0};
    if (setrlimit(RLIMIT_FSIZE, &size) || setrlimit(RLIMIT_NPROC, &procs) ||
        setrlimit(RLIMIT_CORE, &core)) fail("limits");
    if (!strcmp(argv[1], "files")) {
        // Model-driven file ops get the same file-size ceiling as scripts.
        char *args[] = {"/usr/bin/python3", "-I", "/usr/local/libexec/workspace-files.py",
            "file", argv[3], argv[4], NULL};
        char *env[] = {"PATH=/usr/bin:/bin", "LANG=C.UTF-8", NULL};
        execve(args[0], args, env);
        fail("files");
    }
    char home[256], temp[256];
    snprintf(home, sizeof(home), "HOME=%s/%s", ROOT, argv[2]);
    snprintf(temp, sizeof(temp), "TMPDIR=%s/%s", ROOT, argv[2]);
    char *env[] = {"PATH=/usr/bin:/bin", "LANG=C.UTF-8", home, temp, NULL};
    // The interpreter runs under a same-identity wrapper that polls workspace
    // bytes; per-file RLIMIT alone cannot stop a run that spreads writes
    // across many files before post-run accounting sees them.
    char *args[] = {"/usr/bin/python3", "-I", "/usr/local/libexec/workspace-files.py",
        "exec", argv[1], NULL};
    execve(args[0], args, env);
    fail("exec");
}
