#include <limits.h>
#include <mach-o/dyld.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#ifndef PI_SANDBOX_TARGET_PATH
#error PI_SANDBOX_TARGET_PATH must identify a path relative to the launcher
#endif

int main(int argc, char **argv) {
    (void)argc;
    char image[PATH_MAX], launcher[PATH_MAX], target[PATH_MAX];
    uint32_t size = sizeof image;
    if (_NSGetExecutablePath(image, &size) != 0 || realpath(image, launcher) == NULL) {
        fputs("Pi Sandbox: Unable to resolve the bundle launcher.\n", stderr);
        return 126;
    }
    char *separator = strrchr(launcher, '/');
    if (separator == NULL) return 126;
    *separator = '\0';
    int length = snprintf(target, sizeof target, "%s/%s", launcher, PI_SANDBOX_TARGET_PATH);
    if (length < 0 || (size_t)length >= sizeof target) {
        fputs("Pi Sandbox: The bundle target path is too long.\n", stderr);
        return 126;
    }
#ifdef PI_SANDBOX_OPEN_TERMINAL
    (void)argv;
    char *open_args[] = {"open", "-b", "com.apple.Terminal", target, NULL};
    execv("/usr/bin/open", open_args);
    perror("Pi Sandbox: Unable to open Terminal");
#else
    argv[0] = target;
    execv(target, argv);
    perror("Pi Sandbox: Unable to start the bundle executable");
#endif
    return 126;
}
