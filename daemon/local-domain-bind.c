/* Minimal privileged launcher: bind loopback port 80, drop identity, then exec Node.
 * No configuration parsing, shell, dynamic paths from network input, or user code as root.
 */
#include <sys/types.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <grp.h>
#include <fcntl.h>
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void die(const char *message) { perror(message); exit(1); }
static unsigned long identity(const char *text) {
  char *end = NULL;
  errno = 0;
  unsigned long value = strtoul(text, &end, 10);
  if (errno || !*text || *end || text[0] == '-' || value == 0 || value > INT_MAX) {
    fprintf(stderr, "uid/gid must be positive integers\n"); exit(1);
  }
  return value;
}
static int bind_loopback(int family) {
  int fd = socket(family, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  int yes = 1;
  if (setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes)) < 0) die("SO_REUSEADDR");
  if (family == AF_INET6) {
    if (setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &yes, sizeof(yes)) < 0) die("IPV6_V6ONLY");
    struct sockaddr_in6 addr;
    memset(&addr, 0, sizeof(addr)); addr.sin6_family = AF_INET6;
    addr.sin6_addr = in6addr_loopback; addr.sin6_port = htons(80);
    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) { int e=errno; close(fd); errno=e; return -1; }
  } else {
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr)); addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK); addr.sin_port = htons(80);
    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) { int e=errno; close(fd); errno=e; return -1; }
  }
  if (listen(fd, 128) < 0) die("listen");
  /* Reserve above fd4 before moving both sockets into the inherited slots. */
  int reserved = fcntl(fd, F_DUPFD, 5);
  if (reserved < 0) die("reserve socket");
  close(fd);
  return reserved;
}
int main(int argc, char **argv) {
  if (argc != 6 || getuid() != 0) {
    fprintf(stderr, "Usage (root only): bind-helper UID GID /absolute/node /absolute/proxy /absolute/config\n"); return 1;
  }
  uid_t uid = (uid_t)identity(argv[1]); gid_t gid = (gid_t)identity(argv[2]);
  for (int i=3; i<6; ++i) if (argv[i][0] != '/') { fprintf(stderr, "Paths must be absolute\n"); return 1; }
  int v4 = bind_loopback(AF_INET);
  if (v4 < 0) die("Cannot bind 127.0.0.1:80; no alternate port selected");
  int v6 = bind_loopback(AF_INET6);
  if (v6 < 0 && errno != EAFNOSUPPORT && errno != EADDRNOTAVAIL && errno != EPROTONOSUPPORT) die("Cannot bind [::1]:80; no alternate port selected");
  if (dup2(v4, 3) < 0) die("inherit IPv4 socket");
  close(v4);
  if (v6 >= 0) { if (dup2(v6, 4) < 0) die("inherit IPv6 socket"); close(v6); }
  if (fcntl(3, F_SETFD, 0) < 0 || (v6 >= 0 && fcntl(4, F_SETFD, 0) < 0)) die("inherit flags");
  if (setgroups(0, NULL) < 0 || setgid(gid) < 0 || setuid(uid) < 0) die("drop privileges");
  if (getuid() != uid || geteuid() != uid || getgid() != gid || getegid() != gid) {
    fprintf(stderr, "Privilege drop verification failed\n"); return 1;
  }
  execl(argv[3], argv[3], argv[4], "--config", argv[5], "--listen-fds", v6 >= 0 ? "3,4" : "3", (char *)NULL);
  die("exec unprivileged Node");
  return 1;
}
