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

int main(int argc, char **argv) {
    if (argc != 3 || strlen(argv[2]) != 64) return 125;
    for (const char *p = argv[2]; *p; p++)
        if (!(*p >= '0' && *p <= '9') && !(*p >= 'a' && *p <= 'f')) return 125;
    if (strcmp(argv[1], "create") && strcmp(argv[1], "remove") &&
        strcmp(argv[1], "bash") && strcmp(argv[1], "python") &&
        strcmp(argv[1], "usage")) return 125;

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
    int dir = open(argv[2], O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    if (dir < 0) { if (errno == ENOENT && !strcmp(argv[1], "remove")) return 0; fail("directory"); }
    struct stat st;
    if (fstat(dir, &st) || st.st_uid != UID || (st.st_mode & 077) != 0) return 125;
    if (!strcmp(argv[1], "remove")) {
        close(dir);
        char *args[] = {"/usr/bin/python3", "-I", "-c",
            "import shutil,sys; shutil.rmtree(sys.argv[1])", argv[2], NULL};
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
    char home[256], temp[256];
    snprintf(home, sizeof(home), "HOME=%s/%s", ROOT, argv[2]);
    snprintf(temp, sizeof(temp), "TMPDIR=%s/%s", ROOT, argv[2]);
    char *env[] = {"PATH=/usr/bin:/bin", "LANG=C.UTF-8", home, temp, NULL};
    char *bash[] = {"/bin/bash", "--noprofile", "--norc", "-s", NULL};
    char *python[] = {"/usr/bin/python3", "-I", "-", NULL};
    char **args = !strcmp(argv[1], "bash") ? bash : python;
    execve(args[0], args, env);
    fail("exec");
}
