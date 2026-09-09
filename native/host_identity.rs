//! Bounded access to the host's dynamically linked NSS client.
use std::collections::BTreeSet;
use std::fs;
use std::io::{self, Read};
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const GETENT: &str = "/usr/bin/getent";
const MAX_OUTPUT: usize = 65_536;
const MAX_GROUPS: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Account {
    pub user: String,
    pub uid: u32,
    pub gid: u32,
}

pub struct HostIdentityResolver {
    deadline: Instant,
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 256
        && !name.bytes().all(|byte| byte.is_ascii_digit())
        && name.chars().all(|character| {
            !character.is_control() && !character.is_whitespace() && character != ':'
        })
}

fn id(value: &str) -> io::Result<u32> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(invalid("invalid account identifier"));
    }
    value
        .parse()
        .map_err(|_| invalid("account identifier out of range"))
}

fn account_record(text: &str, uid: u32) -> io::Result<Account> {
    let lines: Vec<_> = text.lines().collect();
    if lines.len() != 1 {
        return Err(invalid("expected exactly one passwd record"));
    }
    let fields: Vec<_> = lines[0].split(':').collect();
    if fields.len() != 7 || !valid_name(fields[0]) || id(fields[2])? != uid {
        return Err(invalid("invalid or mismatched passwd record"));
    }
    Ok(Account {
        user: fields[0].to_owned(),
        uid,
        gid: id(fields[3])?,
    })
}

fn group_record(text: &str, name: &str) -> io::Result<u32> {
    let lines: Vec<_> = text.lines().collect();
    if lines.len() != 1 {
        return Err(invalid("expected exactly one group record"));
    }
    let fields: Vec<_> = lines[0].split(':').collect();
    if fields.len() != 4 || fields[0] != name {
        return Err(invalid("invalid or mismatched group record"));
    }
    id(fields[2])
}

fn membership_record(text: &str, account: &Account) -> io::Result<BTreeSet<u32>> {
    let mut fields = text.split_whitespace();
    if fields.next() != Some(account.user.as_str()) {
        return Err(invalid("mismatched initgroups account"));
    }
    let mut groups = BTreeSet::from([account.gid]);
    let mut count = 0;
    for field in fields {
        count += 1;
        if count > MAX_GROUPS {
            return Err(invalid("too many account groups"));
        }
        groups.insert(id(field)?);
    }
    Ok(groups)
}

fn protected_getent() -> io::Result<()> {
    // Check both the named path and its canonical target, including ancestors.
    // This permits administrator-owned /bin -> /usr/bin layouts.
    for path in [Path::new(GETENT).to_path_buf(), fs::canonicalize(GETENT)?] {
        for ancestor in path.ancestors() {
            let meta = fs::metadata(ancestor)?;
            if meta.uid() != 0 || meta.mode() & 0o022 != 0 {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "getent path must be root-owned and protected",
                ));
            }
            if ancestor == path && (!meta.is_file() || meta.mode() & 0o111 == 0) {
                return Err(invalid("getent must be an executable regular file"));
            }
        }
    }
    Ok(())
}

// Every child has its own process group. Reap the leader and kill surviving
// descendants even after successful NSS completion, so they cannot retain pipes.
fn run(mut command: Command, deadline: Instant) -> io::Result<Option<String>> {
    if Instant::now() >= deadline {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "host identity lookup deadline exceeded",
        ));
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0);
    let mut child = command.spawn()?;
    let pid = child.id() as libc::pid_t;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| invalid("missing lookup output"))?;
    let result = (|| {
        let fd = stdout.as_raw_fd();
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            return Err(io::Error::last_os_error());
        }
        let mut output = Vec::new();
        let mut status = None;
        loop {
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "host identity lookup deadline exceeded",
                ));
            }
            let mut buffer = [0u8; 4096];
            loop {
                match stdout.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        if output.len() + count > MAX_OUTPUT {
                            return Err(invalid("host identity output exceeds limit"));
                        }
                        output.extend_from_slice(&buffer[..count]);
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) => return Err(error),
                }
            }
            if let Some(status) = status {
                let status: std::process::ExitStatus = status;
                return match status.code() {
                    Some(0) => String::from_utf8(output)
                        .map(Some)
                        .map_err(|_| invalid("non-UTF-8 host identity output")),
                    Some(2) if output.is_empty() => Ok(None),
                    _ => Err(invalid("host identity lookup failed")),
                };
            }
            status = child.try_wait()?;
            if status.is_some() {
                unsafe {
                    libc::kill(-pid, libc::SIGKILL);
                }
                // Drain buffered output once more after termination.
                continue;
            }
            std::thread::sleep(
                Duration::from_millis(5).min(deadline.saturating_duration_since(Instant::now())),
            );
        }
    })();
    unsafe {
        libc::kill(-pid, libc::SIGKILL);
    }
    let _ = child.wait();
    result
}

impl HostIdentityResolver {
    pub fn new(deadline: Instant) -> Self {
        Self { deadline }
    }

    fn lookup(&self, database: &str, key: &str) -> io::Result<Option<String>> {
        protected_getent()?;
        let mut command = Command::new(GETENT);
        command
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("LANG", "C")
            .env("LC_ALL", "C");
        command.args(["--", database, key]);
        run(command, self.deadline)
    }

    pub fn account(&self, uid: u32) -> io::Result<Option<Account>> {
        self.lookup("passwd", &uid.to_string())?
            .map(|text| account_record(&text, uid))
            .transpose()
    }

    pub fn groups(&self, account: &Account) -> io::Result<BTreeSet<u32>> {
        if !valid_name(&account.user) {
            return Err(invalid("invalid account name"));
        }
        let text = self
            .lookup("initgroups", &account.user)?
            .ok_or_else(|| invalid("account membership unavailable"))?;
        membership_record(&text, account)
    }

    pub fn group(&self, name: &str) -> io::Result<Option<u32>> {
        if !valid_name(name) {
            return Err(invalid("invalid group name"));
        }
        self.lookup("group", name)?
            .map(|text| group_record(&text, name))
            .transpose()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_accounts_and_rejects_wrong_identity_or_ambiguous_names() {
        assert_eq!(
            account_record("alice:x:42:7::/home/alice:/bin/sh\n", 42)
                .unwrap()
                .user,
            "alice"
        );
        for name in ["alice@example.org", "EXAMPLE\\alice", "álîce"] {
            assert!(valid_name(name));
        }
        for name in ["", "123", "a:b", "two words", "line\nname"] {
            assert!(!valid_name(name));
        }
        assert!(account_record("alice:x:43:7::/:/bin/sh", 42).is_err());
        assert!(account_record("123:x:42:7::/:/bin/sh", 42).is_err());
        assert!(account_record("alice:x:42:7::/:/bin/sh\nbob:x:42:7::/:/bin/sh", 42).is_err());
        assert!(group_record("admin:x:10:alice\n", "staff").is_err());
        assert_eq!(group_record("admin:x:10:alice\n", "admin").unwrap(), 10);
    }

    #[test]
    fn membership_includes_primary_and_deduplicates_secondary_groups() {
        let account = Account {
            user: "alice".into(),
            uid: 42,
            gid: 7,
        };
        assert_eq!(
            membership_record("alice 10 20 10\n", &account).unwrap(),
            BTreeSet::from([7, 10, 20])
        );
        assert!(membership_record("bob 10", &account).is_err());
        assert!(membership_record("alice invalid", &account).is_err());
        assert_eq!(
            membership_record("alice", &account).unwrap(),
            BTreeSet::from([7])
        );
        assert!(
            membership_record(&format!("alice {}", "10 ".repeat(MAX_GROUPS + 1)), &account)
                .is_err()
        );
    }

    fn shell(script: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg(script);
        command
    }

    #[test]
    fn bounds_commands_and_distinguishes_missing_accounts() {
        assert_eq!(
            run(
                shell("printf 'alice'"),
                Instant::now() + Duration::from_secs(2)
            )
            .unwrap(),
            Some("alice".into())
        );
        assert_eq!(
            run(shell("exit 2"), Instant::now() + Duration::from_secs(2)).unwrap(),
            None
        );
        assert!(run(shell("exit 3"), Instant::now() + Duration::from_secs(2)).is_err());
        assert!(
            run(
                shell("printf unexpected; exit 2"),
                Instant::now() + Duration::from_secs(2)
            )
            .is_err()
        );
        assert!(run(shell("yes x"), Instant::now() + Duration::from_secs(2)).is_err());
        assert_eq!(
            run(
                shell("sleep 10"),
                Instant::now() + Duration::from_millis(30)
            )
            .unwrap_err()
            .kind(),
            io::ErrorKind::TimedOut
        );
        assert_eq!(
            run(shell("exit 0"), Instant::now()).unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
    }
}
