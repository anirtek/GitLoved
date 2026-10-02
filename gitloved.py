#!/usr/bin/env python3
"""
GitLoved — a faithful clone of the JetBrains IDE Git plugin experience.

Zero dependencies: Python 3 stdlib only. Shells out to your real `git`.

    python3 gitloved.py [path-to-repo] [--port 8765] [--no-browser]

Then open http://127.0.0.1:8765
"""
import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import threading
import time
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

__version__ = "1.0.0"

HERE = Path(__file__).resolve().parent
STATIC = HERE / "static"
CONFIG_FILE = Path.home() / ".gitloved.json"

FIELD_SEP = "\x01"
REC_SEP = "\x02"

state = {
    "repo": None,          # Path of the currently open working tree
    "console": [],         # [{ts, cmd, out, code}]
}
_lock = threading.Lock()


# ---------------------------------------------------------------------------
# config / recent projects
# ---------------------------------------------------------------------------

def load_config():
    try:
        return json.loads(CONFIG_FILE.read_text())
    except Exception:
        return {"recent": []}


def save_config(cfg):
    try:
        CONFIG_FILE.write_text(json.dumps(cfg, indent=2))
    except Exception:
        pass


def remember_project(path):
    cfg = load_config()
    recent = [p for p in cfg.get("recent", []) if p != path]
    recent.insert(0, path)
    cfg["recent"] = recent[:10]
    save_config(cfg)


# ---------------------------------------------------------------------------
# git plumbing
# ---------------------------------------------------------------------------

def run_git(args, cwd=None, log=True, timeout=120):
    """Run git, capture everything, mirror it into the Console tab."""
    cwd = cwd or state["repo"]
    cmd = ["git", "-c", "color.ui=false"] + args
    started = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    try:
        p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                           timeout=timeout, errors="replace")
        out, err, code = p.stdout, p.stderr, p.returncode
    except subprocess.TimeoutExpired:
        out, err, code = "", "command timed out", 124
    except FileNotFoundError:
        out, err, code = "", "git executable not found on PATH", 127
    if log:
        with _lock:
            state["console"].append({
                "ts": started,
                "cwd": str(cwd),
                "cmd": "git " + " ".join(shlex.quote(a) for a in args),
                "out": (out + (("\n" + err) if err else "")).strip(),
                "code": code,
            })
            state["console"] = state["console"][-400:]
    return code, out, err


def require_repo():
    if not state["repo"]:
        raise ApiError(409, "No project is open")


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def git_ok(args, **kw):
    code, out, err = run_git(args, **kw)
    if code != 0:
        raise ApiError(400, (err or out or "git failed").strip())
    return out


# ---------------------------------------------------------------------------
# repo queries
# ---------------------------------------------------------------------------

def repo_summary():
    require_repo()
    code, head, _ = run_git(["symbolic-ref", "--short", "-q", "HEAD"], log=False)
    branch = head.strip() if code == 0 else None
    detached = None
    if branch is None:
        c, out, _ = run_git(["rev-parse", "--short", "HEAD"], log=False)
        detached = out.strip() if c == 0 else None
    ahead = behind = 0
    upstream = None
    if branch:
        c, up, _ = run_git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], log=False)
        if c == 0:
            upstream = up.strip()
            c, lr, _ = run_git(["rev-list", "--left-right", "--count", "@{u}...HEAD"], log=False)
            if c == 0 and lr.strip():
                b, a = lr.split()
                ahead, behind = int(a), int(b)
    c, remotes, _ = run_git(["remote"], log=False)
    ops = current_operation()
    return {
        "path": str(state["repo"]),
        "name": Path(state["repo"]).name,
        "branch": branch,
        "detached": detached,
        "upstream": upstream,
        "ahead": ahead,
        "behind": behind,
        "remotes": remotes.split() if c == 0 else [],
        "operation": ops,
    }


def current_operation():
    """Detect in-progress merge / rebase / cherry-pick, like the IDE banner."""
    git_dir = Path(git_ok(["rev-parse", "--git-dir"], log=False).strip())
    if not git_dir.is_absolute():
        git_dir = Path(state["repo"]) / git_dir
    if (git_dir / "MERGE_HEAD").exists():
        return "merge"
    if (git_dir / "rebase-merge").exists() or (git_dir / "rebase-apply").exists():
        return "rebase"
    if (git_dir / "CHERRY_PICK_HEAD").exists():
        return "cherry-pick"
    if (git_dir / "REVERT_HEAD").exists():
        return "revert"
    return None


def parse_status():
    """git status --porcelain=v1 -z, split into IDE-style groups."""
    require_repo()
    out = git_ok(["status", "--porcelain", "-z", "--untracked-files=all"], log=False)
    entries = out.split("\0")
    changes, unversioned, conflicts = [], [], []
    i = 0
    while i < len(entries):
        e = entries[i]
        if not e:
            i += 1
            continue
        xy, path = e[:2], e[3:]
        item = {"path": path, "xy": xy}
        if xy in ("DD", "AU", "UD", "UA", "DU", "AA", "UU"):
            item["kind"] = "conflict"
            conflicts.append(item)
        elif xy == "??":
            item["kind"] = "untracked"
            unversioned.append(item)
        else:
            if "R" in xy or "C" in xy:      # renamed/copied: next record = original
                i += 1
                item["orig"] = entries[i] if i < len(entries) else None
                item["kind"] = "renamed"
            elif "A" in xy:
                item["kind"] = "added"
            elif "D" in xy:
                item["kind"] = "deleted"
            else:
                item["kind"] = "modified"
            changes.append(item)
        i += 1
    return {"changes": changes, "unversioned": unversioned, "conflicts": conflicts}


def parse_log(limit=300, branch=None, search=None, author=None, all_refs=True):
    require_repo()
    fmt = FIELD_SEP.join(["%H", "%P", "%an", "%ae", "%aI", "%s", "%D"]) + REC_SEP
    args = ["log", f"--max-count={limit}", "--topo-order", f"--pretty=format:{fmt}"]
    if branch:
        args.append(branch)
    elif all_refs:
        args += ["--branches", "--remotes", "--tags", "HEAD"]
    if search:
        args += ["--grep", search, "-i"]
    if author:
        args += ["--author", author, "-i"]
    code, out, err = run_git(args, log=False)
    if code != 0:
        # empty repository (no commits yet)
        if "does not have any commits" in err or "bad default revision" in err:
            return {"commits": [], "head": None}
        raise ApiError(400, err.strip() or "git log failed")
    rc, rnames, _ = run_git(["remote"], log=False)
    remotes = set(rnames.split()) if rc == 0 else set()
    commits = []
    for rec in out.split(REC_SEP):
        rec = rec.strip("\n")
        if not rec:
            continue
        h, parents, an, ae, date, subject, refs = rec.split(FIELD_SEP)
        refl = []
        head_here = False
        for r in [x.strip() for x in refs.split(",") if x.strip()]:
            if r == "HEAD":
                head_here = True
            elif r.startswith("HEAD -> "):
                head_here = True
                refl.append({"name": r[8:], "type": "local"})
            elif r.startswith("tag: "):
                refl.append({"name": r[5:], "type": "tag"})
            elif r.split("/", 1)[0] in remotes:
                refl.append({"name": r, "type": "remote"})
            else:
                refl.append({"name": r, "type": "local"})
        commits.append({
            "hash": h, "short": h[:8],
            "parents": parents.split() if parents else [],
            "author": an, "email": ae, "date": date,
            "subject": subject, "refs": refl, "head": head_here,
        })
    c, head, _ = run_git(["rev-parse", "HEAD"], log=False)
    return {"commits": commits, "head": head.strip() if c == 0 else None}


def commit_details(h):
    require_repo()
    fmt = FIELD_SEP.join(["%H", "%P", "%an", "%ae", "%aI", "%cn", "%cI", "%s", "%b"])
    out = git_ok(["show", "--no-patch", f"--pretty=format:{fmt}", h], log=False)
    H, P, an, ae, ad, cn, cd, s, b = (out.split(FIELD_SEP) + [""] * 9)[:9]
    files = []
    # like the IDE, a merge commit lists its changes against the first parent
    nout = git_ok(["show", "--name-status", "--pretty=format:", "-z",
                   "-M", "-m", "--first-parent", h], log=False)
    toks = [t for t in nout.split("\0")]
    i = 0
    while i < len(toks):
        st = toks[i]
        if not st:
            i += 1
            continue
        if st.startswith(("R", "C")):
            files.append({"status": st[0], "orig": toks[i + 1], "path": toks[i + 2]})
            i += 3
        else:
            files.append({"status": st[0], "path": toks[i + 1]})
            i += 2
    return {"hash": H, "parents": P.split(), "author": an, "email": ae,
            "authorDate": ad, "committer": cn, "commitDate": cd,
            "subject": s, "body": b.strip(), "files": files}


def branch_list():
    require_repo()
    fmt = FIELD_SEP.join(["%(refname:short)", "%(upstream:short)", "%(upstream:track)",
                          "%(HEAD)", "%(objectname:short)", "%(committerdate:iso-strict)"])
    out = git_ok(["for-each-ref", "refs/heads", f"--format={fmt}",
                  "--sort=-committerdate"], log=False)
    local = []
    for line in out.splitlines():
        name, up, track, head, obj, date = line.split(FIELD_SEP)
        ahead = behind = 0
        m = re.search(r"ahead (\d+)", track)
        if m:
            ahead = int(m.group(1))
        m = re.search(r"behind (\d+)", track)
        if m:
            behind = int(m.group(1))
        local.append({"name": name, "upstream": up or None, "gone": "gone" in track,
                      "ahead": ahead, "behind": behind,
                      "current": head == "*", "hash": obj, "date": date})
    # full refname: recent git shortens refs/remotes/origin/HEAD to just "origin"
    out = git_ok(["for-each-ref", "refs/remotes",
                  "--format=%(refname)", "--sort=refname"], log=False)
    remote = [{"name": n[len("refs/remotes/"):]} for n in out.splitlines()
              if not n.endswith("/HEAD")]
    c, tout, _ = run_git(["tag", "--sort=-creatordate"], log=False)
    tags = tout.split() if c == 0 else []
    c, sout, _ = run_git(["stash", "list", "--pretty=format:%gd\x01%s"], log=False)
    stashes = []
    if c == 0:
        for line in sout.splitlines():
            if FIELD_SEP in line:
                ref, msg = line.split(FIELD_SEP, 1)
                stashes.append({"ref": ref, "message": msg})
    return {"local": local, "remote": remote, "tags": tags[:100], "stashes": stashes}


# ---------------------------------------------------------------------------
# diffs
# ---------------------------------------------------------------------------

def worktree_diff(path, kind):
    require_repo()
    if kind == "untracked":
        args = ["diff", "--no-index", "--", "/dev/null", path]
        code, out, err = run_git(args, log=False)
        if code in (0, 1):
            return out
        raise ApiError(400, err.strip() or "diff failed")
    if kind == "conflict":
        code, out, _ = run_git(["diff", "--", path], log=False)
        return out
    code, out, err = run_git(["diff", "HEAD", "--", path], log=False)
    if code != 0:  # e.g. unborn HEAD
        code, out, err = run_git(["diff", "--cached", "--", path], log=False)
    return out


def commit_diff(h, path):
    require_repo()
    code, out, err = run_git(["show", "--pretty=format:", "-M", "-m", "--first-parent",
                                 h, "--", path], log=False)
    if code != 0:
        raise ApiError(400, err.strip() or "diff failed")
    return out


def file_at(rev, path):
    code, out, _ = run_git(["show", f"{rev}:{path}"], log=False)
    return out if code == 0 else ""


# ---------------------------------------------------------------------------
# actions (the dispatcher behind every dialog / menu item)
# ---------------------------------------------------------------------------

def do_action(name, a):
    require_repo()

    if name == "checkout":
        return git_ok(["checkout", a["branch"]])

    if name == "checkout_remote":
        # like the IDE: create a local tracking branch and switch to it
        local = a.get("as") or a["branch"].split("/", 1)[1]
        return git_ok(["checkout", "-b", local, "--track", a["branch"]])

    if name == "checkout_revision":
        return git_ok(["checkout", a["rev"]])

    if name == "new_branch":
        args = ["checkout", "-b", a["name"]] if a.get("checkout", True) else ["branch", a["name"]]
        if a.get("from"):
            args.append(a["from"])
        return git_ok(args)

    if name == "rename_branch":
        return git_ok(["branch", "-m", a["old"], a["new"]])

    if name == "delete_branch":
        return git_ok(["branch", "-D" if a.get("force") else "-d", a["branch"]])

    if name == "delete_remote_branch":
        remote, _, ref = a["branch"].partition("/")
        return git_ok(["push", remote, "--delete", ref], timeout=300)

    if name == "merge":
        args = ["merge"]
        if a.get("noFf"):
            args.append("--no-ff")
        if a.get("squash"):
            args.append("--squash")
        args.append(a["branch"])
        return git_ok(args)

    if name == "rebase":
        return git_ok(["rebase", a["onto"]])

    if name == "abort":
        op = a["op"]
        if op == "merge":
            return git_ok(["merge", "--abort"])
        if op == "rebase":
            return git_ok(["rebase", "--abort"])
        if op == "cherry-pick":
            return git_ok(["cherry-pick", "--abort"])
        if op == "revert":
            return git_ok(["revert", "--abort"])
        raise ApiError(400, f"unknown operation {op}")

    if name == "continue":
        op = a["op"]
        env_args = ["-c", "core.editor=true"]
        if op == "rebase":
            return git_ok(env_args + ["rebase", "--continue"])
        if op == "merge":
            return git_ok(env_args + ["merge", "--continue"])
        if op == "cherry-pick":
            return git_ok(env_args + ["cherry-pick", "--continue"])
        if op == "revert":
            return git_ok(env_args + ["revert", "--continue"])
        raise ApiError(400, f"unknown operation {op}")

    if name == "fetch":
        return git_ok(["fetch", "--all", "--prune"], timeout=300)

    if name == "pull":
        args = ["pull"]
        if a.get("rebase"):
            args.append("--rebase")
        if a.get("ffOnly"):
            args.append("--ff-only")
        if a.get("prune"):
            args.append("--prune")
        if a.get("remote"):
            args.append(a["remote"])
            if a.get("branch"):
                args.append(a["branch"])
        return git_ok(args, timeout=300)

    if name == "push":
        args = ["push"]
        if a.get("forceWithLease"):
            args.append("--force-with-lease")
        elif a.get("force"):
            args.append("--force")
        if a.get("tags"):
            args.append("--tags")
        if a.get("setUpstream"):
            args.append("--set-upstream")
        args.append(a.get("remote") or "origin")
        if a.get("refspec"):
            args.append(a["refspec"])
        return git_ok(args, timeout=300)

    if name == "commit":
        files = a.get("files") or []
        msg = (a.get("message") or "").strip()
        if not msg and not a.get("amend"):
            raise ApiError(400, "Commit message is empty")
        if files:
            git_ok(["add", "-A", "--"] + files)
        args = ["commit"]
        if a.get("amend"):
            args.append("--amend")
            if not msg:
                args.append("--no-edit")
        if msg:
            args += ["-m", msg]
        if not files and not a.get("amend"):
            args.append("-a")  # commit everything, IDE-style "all changes"
        out = git_ok(args)
        if a.get("push"):
            out += "\n" + do_action("push", a.get("pushArgs") or {})
        return out

    if name == "rollback":
        tracked = a.get("tracked") or []
        untracked = a.get("untracked") or []
        out = ""
        if tracked:
            out += git_ok(["checkout", "HEAD", "--"] + tracked)
        if untracked:
            out += git_ok(["clean", "-fd", "--"] + untracked)
        return out or "Rolled back"

    if name == "add":
        return git_ok(["add", "--"] + a["files"])

    if name == "resolve":
        side = "--ours" if a["side"] == "ours" else "--theirs"
        git_ok(["checkout", side, "--"] + a["files"])
        return git_ok(["add", "--"] + a["files"])

    if name == "stash":
        args = ["stash", "push"]
        if a.get("message"):
            args += ["-m", a["message"]]
        if a.get("keepIndex"):
            args.append("--keep-index")
        if a.get("includeUntracked", True):
            args.append("--include-untracked")
        return git_ok(args)

    if name == "unstash":
        cmd = "pop" if a.get("pop", True) else "apply"
        return git_ok(["stash", cmd, a.get("ref", "stash@{0}")])

    if name == "drop_stash":
        return git_ok(["stash", "drop", a["ref"]])

    if name == "cherry_pick":
        extra = ["-m", "1"] if _is_merge(a["hash"]) else []
        return git_ok(["cherry-pick"] + extra + [a["hash"]])

    if name == "revert_commit":
        extra = ["-m", "1"] if _is_merge(a["hash"]) else []
        return git_ok(["-c", "core.editor=true", "revert"] + extra + [a["hash"]])

    if name == "reset":
        mode = a.get("mode", "mixed")
        if mode not in ("soft", "mixed", "hard", "keep"):
            raise ApiError(400, "bad reset mode")
        return git_ok(["reset", f"--{mode}", a["to"]])

    if name == "tag":
        args = ["tag", a["name"]]
        if a.get("on"):
            args.append(a["on"])
        return git_ok(args)

    if name == "init":
        return git_ok(["init"], cwd=a["path"])

    if name == "clone":
        args = ["clone", a["url"]]
        if a.get("dir"):
            args.append(a["dir"])
        return git_ok(args, cwd=a["parent"], timeout=900)

    raise ApiError(400, f"Unknown action: {name}")


def _is_merge(h):
    c, out, _ = run_git(["show", "-s", "--format=%P", h], log=False)
    return c == 0 and len(out.split()) > 1


# ---------------------------------------------------------------------------
# filesystem browsing (Open Project dialog)
# ---------------------------------------------------------------------------

def browse(path):
    p = Path(path or Path.home()).expanduser().resolve()
    if not p.is_dir():
        p = Path.home()
    dirs = []
    try:
        for child in sorted(p.iterdir(), key=lambda c: c.name.lower()):
            if child.is_dir() and not child.name.startswith("."):
                dirs.append({
                    "name": child.name,
                    "path": str(child),
                    "isRepo": (child / ".git").exists(),
                })
    except PermissionError:
        pass
    return {"path": str(p), "parent": str(p.parent) if p.parent != p else None,
            "isRepo": (p / ".git").exists(), "dirs": dirs}


def open_project(path):
    p = Path(path).expanduser().resolve()
    if not p.is_dir():
        raise ApiError(400, f"Not a directory: {p}")
    code, out, _ = run_git(["rev-parse", "--show-toplevel"], cwd=p, log=False)
    if code != 0:
        raise ApiError(412, f"'{p}' is not a Git repository")
    state["repo"] = out.strip()
    remember_project(state["repo"])
    return repo_summary()


# ---------------------------------------------------------------------------
# HTTP layer
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = f"GitLoved/{__version__}"

    def log_message(self, *args):
        pass

    # -- helpers ------------------------------------------------------------
    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path, ctype):
        try:
            data = path.read_bytes()
        except FileNotFoundError:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n == 0:
            return {}
        return json.loads(self.rfile.read(n).decode())

    def trusted(self, post=False):
        """Only answer our own UI: blocks DNS rebinding and cross-site requests."""
        port = self.server.server_address[1]
        allowed = {f"127.0.0.1:{port}", f"localhost:{port}"}
        if self.headers.get("Host") not in allowed:
            return False
        origin = self.headers.get("Origin")
        if origin and urlparse(origin).netloc not in allowed:
            return False
        if post:
            # a cross-site form can't send application/json without a CORS preflight
            ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip()
            if ctype != "application/json":
                return False
        return True

    # -- routing ------------------------------------------------------------
    def do_GET(self):
        if not self.trusted():
            return self.send_error(403)
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        route = url.path
        try:
            if route == "/" or route == "/index.html":
                return self.send_file(STATIC / "index.html", "text/html; charset=utf-8")
            if route == "/style.css":
                return self.send_file(STATIC / "style.css", "text/css; charset=utf-8")
            if route == "/app.js":
                return self.send_file(STATIC / "app.js", "text/javascript; charset=utf-8")

            if route == "/api/recent":
                cfg = load_config()
                recent = [{"path": p, "name": Path(p).name,
                           "exists": Path(p).is_dir()} for p in cfg.get("recent", [])]
                return self.send_json({"recent": recent,
                                       "open": str(state["repo"]) if state["repo"] else None})
            if route == "/api/browse":
                return self.send_json(browse(q.get("path")))
            if route == "/api/summary":
                return self.send_json(repo_summary())
            if route == "/api/status":
                return self.send_json(parse_status())
            if route == "/api/log":
                return self.send_json(parse_log(
                    limit=int(q.get("limit", 300)),
                    branch=q.get("branch") or None,
                    search=q.get("search") or None,
                    author=q.get("author") or None))
            if route == "/api/commit":
                return self.send_json(commit_details(q["hash"]))
            if route == "/api/branches":
                return self.send_json(branch_list())
            if route == "/api/diff":
                return self.send_json({"diff": worktree_diff(q["path"], q.get("kind", "modified"))})
            if route == "/api/diff_commit":
                return self.send_json({"diff": commit_diff(q["hash"], q["path"])})
            if route == "/api/console":
                with _lock:
                    return self.send_json({"lines": state["console"][-200:]})
            self.send_error(404)
        except ApiError as e:
            self.send_json({"error": e.message}, e.status)
        except Exception as e:  # pragma: no cover
            self.send_json({"error": f"{type(e).__name__}: {e}"}, 500)

    def do_POST(self):
        if not self.trusted(post=True):
            return self.send_error(403)
        url = urlparse(self.path)
        try:
            body = self.read_body()
            if url.path == "/api/open":
                return self.send_json(open_project(body["path"]))
            if url.path == "/api/action":
                out = do_action(body["name"], body.get("args") or {})
                return self.send_json({"ok": True, "output": out,
                                       "summary": repo_summary()})
            self.send_error(404)
        except ApiError as e:
            self.send_json({"error": e.message}, e.status)
        except Exception as e:  # pragma: no cover
            self.send_json({"error": f"{type(e).__name__}: {e}"}, 500)


def main():
    parser = argparse.ArgumentParser(
        prog="gitloved",
        description="The JetBrains Git plugin experience as a standalone local web app.")
    parser.add_argument("repo", nargs="?", help="repository to open (default: Welcome screen)")
    parser.add_argument("--port", type=int, default=8765, help="port to listen on (default: 8765)")
    parser.add_argument("--no-browser", action="store_true", help="don't open a browser tab")
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    opts = parser.parse_args()

    if opts.repo:
        try:
            print(json.dumps(open_project(opts.repo), indent=2))
        except ApiError as e:
            print(f"warning: {e.message}", file=sys.stderr)
    server = ThreadingHTTPServer(("127.0.0.1", opts.port), Handler)
    url = f"http://127.0.0.1:{opts.port}"
    print(f"GitLoved running at {url}")
    if not opts.no_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
