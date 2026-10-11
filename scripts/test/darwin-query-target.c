/* Bounded test target for Darwin observation, never shipped as a helper. */
#include <stdio.h>
#include <sys/ptrace.h>
#include <unistd.h>

int main(void) {
  alarm(30);
  if (setsid() < 0 || ptrace(PT_DENY_ATTACH, 0, NULL, 0) < 0) return 1;
  puts("READY");
  fflush(stdout);
  for (;;) pause();
}
