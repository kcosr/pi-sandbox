#include <limits.h>
#include <mach-o/dyld.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#ifndef PI_SANDBOX_CLIENT_PATH
#error PI_SANDBOX_CLIENT_PATH must identify the executable relative to the launcher
#endif

int main(int argc, char **argv) {
    (void)argc;
    char image[PATH_MAX], launcher[PATH_MAX], client[PATH_MAX];
    uint32_t size = sizeof image;
    if (_NSGetExecutablePath(image, &size) != 0 || realpath(image, launcher) == NULL) {
        fputs("Pi Sandbox: Unable to resolve the bundle launcher.\n", stderr);
        return 126;
    }
    char *separator = strrchr(launcher, '/');
    if (separator == NULL) return 126;
    *separator = '\0';
    int length = snprintf(client, sizeof client, "%s/%s", launcher, PI_SANDBOX_CLIENT_PATH);
    if (length < 0 || (size_t)length >= sizeof client) {
        fputs("Pi Sandbox: The bundle executable path is too long.\n", stderr);
        return 126;
    }
    argv[0] = client;
    execv(client, argv);
    perror("Pi Sandbox: Unable to start the bundle executable");
    return 126;
}
