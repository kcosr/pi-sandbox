/* Development probe, not a runtime dependency. Build with the Apple SDK.
 * One same-user PID in, one bounded JSON observation out. No signals, child
 * processes, persistent state, environment output, or process supervision.
 * Byte strings are hexadecimal so argv boundaries and arbitrary bytes survive.
 */
#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc.h>
#include <sys/sysctl.h>
#include <unistd.h>

static int absent(void) {
  puts("{\"version\":1,\"state\":\"absent\"}");
  return 0;
}

static int fail(const char *operation) {
  fprintf(stderr, "darwin_process_query_failed:%s:%d\n", operation, errno);
  return 1;
}

static int info(pid_t pid, struct proc_bsdinfo *result) {
  memset(result, 0, sizeof(*result));
  errno = 0;
  int size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, result, sizeof(*result));
  if (size == 0 && errno == ESRCH) return 0;
  if (size != sizeof(*result)) return -1;
  if (result->pbi_pid != (uint32_t)pid || result->pbi_uid != geteuid() ||
      result->pbi_start_tvsec == 0 || result->pbi_start_tvusec >= 1000000) {
    errno = EPERM;
    return -1;
  }
  return result->pbi_status == SZOMB ? 0 : 1;
}

static void hex(const unsigned char *bytes, size_t length) {
  static const char digits[] = "0123456789abcdef";
  putchar('"');
  for (size_t i = 0; i < length; i++) {
    putchar(digits[bytes[i] >> 4]);
    putchar(digits[bytes[i] & 15]);
  }
  putchar('"');
}

int main(int argc, char **argv) {
  if (argc != 2 || !argv[1][0] || argv[1][0] == '0') return 2;
  for (const char *p = argv[1]; *p; p++)
    if (*p < '0' || *p > '9') return 2;
  char *end;
  errno = 0;
  long parsed = strtol(argv[1], &end, 10);
  if (errno || *end || parsed <= 0 || parsed > INT_MAX) return 2;
  pid_t pid = (pid_t)parsed;
  struct proc_bsdinfo before, after;
  int found = info(pid, &before);
  if (found == 0) return absent();
  if (found < 0) return fail("bsdinfo_before");

  unsigned char executable[PROC_PIDPATHINFO_MAXSIZE];
  unsigned char final_executable[PROC_PIDPATHINFO_MAXSIZE];
  int executable_size = proc_pidpath(pid, executable, sizeof(executable));
  if (executable_size <= 0) return fail("path_before");
  size_t executable_length = strnlen((char *)executable, sizeof(executable));
  if (executable_length == sizeof(executable)) return fail("path_bounds");

  int argmax = 0, mib[] = {CTL_KERN, KERN_ARGMAX};
  size_t size = sizeof(argmax);
  if (sysctl(mib, 2, &argmax, &size, NULL, 0) || size != sizeof(argmax) ||
      argmax <= (int)sizeof(int) || argmax > 1048576) return fail("argmax");
  unsigned char *buffer = calloc(1, (size_t)argmax);
  if (!buffer) return fail("allocation");
  int args_mib[] = {CTL_KERN, KERN_PROCARGS2, pid};
  size = (size_t)argmax;
  if (sysctl(args_mib, 3, buffer, &size, NULL, 0) || size <= sizeof(int)) {
    free(buffer);
    return fail("procargs");
  }
  int arguments;
  memcpy(&arguments, buffer, sizeof(arguments));
  if (arguments < 1 || arguments > 4096) { free(buffer); return fail("argc"); }
  size_t offsets[4096], lengths[4096];
  size_t cursor = sizeof(int);
  while (cursor < size && buffer[cursor]) cursor++; /* kernel executable */
  while (cursor < size && !buffer[cursor]) cursor++; /* alignment padding */
  for (int i = 0; i < arguments; i++) {
    if (cursor >= size) { free(buffer); return fail("argv_bounds"); }
    offsets[i] = cursor;
    while (cursor < size && buffer[cursor]) cursor++;
    if (cursor == size) { free(buffer); return fail("argv_termination"); }
    lengths[i] = cursor - offsets[i];
    cursor++;
  }
  /* No bytes after argc strings (the environment) are emitted. */
  int final_size = proc_pidpath(pid, final_executable, sizeof(final_executable));
  found = info(pid, &after);
  if (found == 0) { free(buffer); return absent(); }
  if (found < 0 || final_size <= 0 ||
      before.pbi_start_tvsec != after.pbi_start_tvsec ||
      before.pbi_start_tvusec != after.pbi_start_tvusec ||
      strnlen((char *)final_executable, sizeof(final_executable)) != executable_length ||
      memcmp(executable, final_executable, executable_length)) {
    free(buffer);
    return fail("generation_changed");
  }
  printf("{\"version\":1,\"state\":\"present\",\"pid\":%d,"
         "\"startSeconds\":\"%" PRIu64 "\",\"startMicroseconds\":\"%" PRIu64
         "\",\"uid\":%u,\"processGroup\":%u,\"executableHex\":",
         pid, before.pbi_start_tvsec, before.pbi_start_tvusec,
         before.pbi_uid, before.pbi_pgid);
  hex(executable, executable_length);
  fputs(",\"argvHex\":[", stdout);
  for (int i = 0; i < arguments; i++) {
    if (i) putchar(',');
    hex(buffer + offsets[i], lengths[i]);
  }
  puts("]}");
  free(buffer);
  return ferror(stdout) ? 1 : 0;
}
