// Tests for the port layer. Model.js has no Qt in it, so the whole parser,
// classifier, filter, grouping and formatting engine runs here:
// `node test/model-test.js`.

const assert = require("assert")
const M = require("../Model.js")

// Captured from `ss -tlnpH` on Arch, plus the /proc walk the probe adds. The
// three interesting shapes are all here: a threaded runtime whose comm lies
// about what it is (MainThread → Vite), a server whose working directory is
// not its project root (Laravel's public/), and ports owned by other users
// that carry no process at all.
const probe = [
  "SELF\t1000",
  "SSRC\t0",
  'SOCK\tLISTEN 0      4096         0.0.0.0:56643 0.0.0.0:* users:(("spotify",pid=397786,fd=225))',
  "SOCK\tLISTEN 0      4096       127.0.0.1:11434 0.0.0.0:*",
  'SOCK\tLISTEN 0      511        127.0.0.1:33311 0.0.0.0:* users:(("MainThread",pid=586789,fd=30))',
  "SOCK\tLISTEN 0      4096       127.0.0.1:631   0.0.0.0:*",
  'SOCK\tLISTEN 0      4096       127.0.0.1:8000  0.0.0.0:* users:(("php",pid=367572,fd=7))',
  "SOCK\tLISTEN 0      4096      172.17.0.1:53    0.0.0.0:*",
  "SOCK\tLISTEN 0      4096   127.0.0.53%lo:53    0.0.0.0:*",
  "SOCK\tLISTEN 0      200        127.0.0.1:5432  0.0.0.0:*",
  'SOCK\tLISTEN 0      511            [::1]:3000     [::]:* users:(("MainThread",pid=586789,fd=34))',
  'SOCK\tLISTEN 0      511        127.0.0.1:3000     0.0.0.0:* users:(("MainThread",pid=586789,fd=35))',
  "SOCK\tLISTEN 0      200            [::1]:5432     [::]:*",
  'SOCK\tUNCONN 0      0            0.0.0.0:1900  0.0.0.0:* users:(("spotify",pid=397786,fd=283))',
  "PROC\t367572\t1000\tphp\t/home/mich/Projects/DistressNowApi/public\t17988\t/home/mich/Projects/DistressNowApi\t/usr/bin/php -S 127.0.0.1:8000 /home/mich/Projects/DistressNowApi/vendor/laravel/framework/src/Illuminate/Foundation/Console/../resources/server.php",
  "PROC\t397786\t1000\tspotify\t/home/mich\t16529\t\t/opt/spotify/spotify --uri",
  "PROC\t586789\t1000\tMainThread\t/home/mich/Projects/nexahubtech\t861\t/home/mich/Projects/nexahubtech\tnode /home/mich/Projects/nexahubtech/node_modules/.bin/vite dev --port 3000"
].join("\n")

const parsed = M.parseProbe(probe)
const rows = M.buildRows(parsed, { home: "/home/mich" })

function rowFor(port) {
  const hit = rows.filter(r => r.port === port)
  assert.strictEqual(hit.length, 1, "expected exactly one row for port " + port)
  return hit[0]
}

// ---------------------------------------------------------------- parsing

{
  assert.strictEqual(parsed.ok, true)
  assert.strictEqual(parsed.selfUid, 1000)
  assert.strictEqual(parsed.procs[586789].comm, "MainThread")
  assert.strictEqual(parsed.procs[586789].root, "/home/mich/Projects/nexahubtech")
  assert.strictEqual(parsed.procs[397786].root, "")

  // A failed `ss` is not an empty one, and the two have to stay tellable apart.
  assert.strictEqual(M.parseProbe("SELF\t1000\nSSRC\t1").ok, false)
  assert.strictEqual(M.parseProbe("").ok, false)
}

{
  const sock = M.parseSocketLine('LISTEN 0 511 [::1]:3000 [::]:* users:(("node",pid=12,fd=3),("node",pid=13,fd=4))', "tcp")
  assert.strictEqual(sock.addr, "::1")
  assert.strictEqual(sock.port, 3000)
  assert.strictEqual(sock.users.length, 2)
  assert.strictEqual(sock.users[1].pid, 13)

  // The scope suffix on a link-local address is not part of the address.
  assert.strictEqual(M.splitHostPort("127.0.0.53%lo:53").host, "127.0.0.53")
  assert.strictEqual(M.splitHostPort("*:8080").host, "*")
  assert.strictEqual(M.splitHostPort("[::]:631").host, "::")
  assert.strictEqual(M.splitHostPort("nonsense"), null)
  assert.strictEqual(M.parseSocketLine("", "tcp"), null)
}

// ---------------------------------------------------------------- merging

{
  // One dev server bound to both 127.0.0.1 and ::1 is one row, or every count
  // in the panel doubles.
  const three = rowFor(3000)
  assert.deepStrictEqual(three.addrs.sort(), ["127.0.0.1", "::1"])
  assert.strictEqual(three.scope, "loopback")
  assert.strictEqual(three.exposed, false)

  // Same for a service nobody here owns.
  assert.deepStrictEqual(rowFor(5432).addrs.sort(), ["127.0.0.1", "::1"])

  // Different pids on the same port stay separate rows; so do tcp and udp.
  assert.strictEqual(rows.filter(r => r.proto === "udp").length, 1)
  assert.strictEqual(rowFor(1900).proto, "udp")
}

// ---------------------------------------------------------------- naming

{
  // The whole reason the probe reads /proc: `ss` says "MainThread".
  const three = rowFor(3000)
  assert.strictEqual(three.runtime, "Vite")
  assert.strictEqual(M.displayName(three), "Vite")
  assert.strictEqual(three.project, "nexahubtech")
  assert.strictEqual(three.mine, true)
  assert.ok(M.primaryLabel(three).indexOf("3000") === 0)

  // Laravel serves from public/; the project is the checkout above it.
  assert.strictEqual(rowFor(8000).project, "DistressNowApi")
  assert.strictEqual(rowFor(8000).runtime, "PHP")

  // A port with no readable owner still gets named when it is well known.
  assert.strictEqual(rowFor(5432).pid, 0)
  assert.strictEqual(M.displayName(rowFor(5432)), "PostgreSQL")
  assert.strictEqual(M.displayName(rowFor(11434)), "Ollama")

  // Spotify runs from the home directory, which names no project.
  assert.strictEqual(rowFor(56643).project, "")
  assert.strictEqual(M.displayName(rowFor(56643)), "spotify")

  assert.strictEqual(M.projectOf("/home/mich", "/home/mich", ""), "")
  assert.strictEqual(M.projectOf("/", "/home/mich", ""), "")
  assert.strictEqual(M.projectOf("/home/mich/src/api", "/home/mich", ""), "api")
}

{
  assert.strictEqual(M.runtimeOf("node /x/node_modules/.bin/next dev", "node"), "Next.js")
  assert.strictEqual(M.runtimeOf("python3 -m uvicorn app:main", "MainThread"), "Uvicorn")
  assert.strictEqual(M.runtimeOf("python3 -m http.server 8000", "python3"), "Python http.server")
  assert.strictEqual(M.runtimeOf("/usr/bin/docker-proxy -container-port 5432", ""), "Docker")
  assert.strictEqual(M.runtimeOf("", ""), "")
}

// ---------------------------------------------------------------- scope

{
  assert.strictEqual(M.scopeOf(["127.0.0.1", "::1"]), "loopback")
  assert.strictEqual(M.scopeOf(["0.0.0.0"]), "any")
  assert.strictEqual(M.scopeOf(["::"]), "any")
  assert.strictEqual(M.scopeOf(["192.168.1.20"]), "iface")
  // The worst case wins: one wildcard bind exposes the port however many
  // loopback binds sit next to it.
  assert.strictEqual(M.scopeOf(["127.0.0.1", "0.0.0.0"]), "any")

  assert.strictEqual(rowFor(56643).scope, "any")
  assert.strictEqual(rowFor(53).scope, "iface")
}

// ---------------------------------------------------------------- classifying

{
  // In a dev range, or run by a dev runtime, or named by the user.
  assert.strictEqual(rowFor(3000).dev, true)
  assert.strictEqual(rowFor(8000).dev, true)
  assert.strictEqual(rowFor(33311).dev, true)   // random port, but Vite holds it

  // Infrastructure is not the thing you are building.
  assert.strictEqual(rowFor(5432).dev, false)
  assert.strictEqual(rowFor(631).dev, false)
  assert.strictEqual(rowFor(11434).dev, false)

  // Nor is a desktop app that happens to listen.
  assert.strictEqual(rowFor(56643).dev, false)

  const withExtra = M.buildRows(parsed, { home: "/home/mich", devPorts: M.parsePortList("11434") })
  assert.strictEqual(withExtra.filter(r => r.port === 11434)[0].dev, true)

  const hidden = M.buildRows(parsed, { home: "/home/mich", ignorePorts: M.parsePortList("5432, 631") })
  assert.strictEqual(hidden.filter(r => r.port === 5432).length, 0)
  assert.strictEqual(hidden.filter(r => r.port === 631).length, 0)
}

{
  assert.deepStrictEqual(M.parsePortList("3000, 4000-4010 8080"), [[3000, 3000], [4000, 4010], [8080, 8080]])
  assert.deepStrictEqual(M.parsePortList(""), [])
  assert.deepStrictEqual(M.parsePortList("junk"), [])
  // A backwards range is a typo, not an instruction.
  assert.deepStrictEqual(M.parsePortList("90-80"), [])
  assert.strictEqual(M.inRanges(4005, [[4000, 4010]]), true)
  assert.strictEqual(M.inRanges(4011, [[4000, 4010]]), false)
}

// ---------------------------------------------------------------- links

{
  assert.strictEqual(rowFor(3000).url, "http://localhost:3000")
  assert.strictEqual(rowFor(631).url, "http://localhost:631")
  // Nothing points a browser at Postgres.
  assert.strictEqual(rowFor(5432).http, false)
  assert.strictEqual(rowFor(5432).url, "")
  assert.strictEqual(M.copyText(rowFor(5432)), "localhost:5432")

  const secure = M.buildRows(parsed, { home: "/home/mich", httpsPorts: M.parsePortList("8000") })
  assert.strictEqual(secure.filter(r => r.port === 8000)[0].url, "https://localhost:8000")
}

// ---------------------------------------------------------------- filtering

{
  const dev = M.filterBy(rows, "dev").map(r => r.port).sort((a, b) => a - b)
  assert.deepStrictEqual(dev, [3000, 8000, 33311])

  assert.deepStrictEqual(M.filterBy(rows, "exposed").map(r => r.port).sort((a, b) => a - b), [53, 1900, 56643])
  assert.strictEqual(M.filterBy(rows, "all").length, rows.length)
  assert.ok(M.filterBy(rows, "mine").every(r => r.mine))

  // Search covers the things a person would actually type: the port, the
  // framework, and the project. The command line is in there too, which is
  // why "3000" also finds the sibling port of a server started with
  // `--port 3000` — the same server, reached by the number you remember.
  assert.deepStrictEqual(M.searchBy(rows, "3000").map(r => r.port).sort((a, b) => a - b), [3000, 33311])
  assert.strictEqual(M.searchBy(rows, "vite").length, 2)
  assert.strictEqual(M.searchBy(rows, "nexahubtech").length, 2)
  assert.strictEqual(M.searchBy(rows, "8000").length, 1)
  assert.strictEqual(M.searchBy(rows, "php 8000").length, 1)
  assert.strictEqual(M.searchBy(rows, "nothing-here").length, 0)
  assert.strictEqual(M.searchBy(rows, "").length, rows.length)
}

// ---------------------------------------------------------------- grouping

{
  const groups = M.groupItems(rows)
  const names = groups.map(g => g.name)

  assert.ok(names.indexOf("nexahubtech") >= 0)
  assert.ok(names.indexOf("DistressNowApi") >= 0)
  // Daemons nobody here owns share one heading rather than each getting
  // their own one-row group.
  assert.ok(names.indexOf("system") >= 0)
  assert.strictEqual(names[names.length - 1], "system")
  assert.strictEqual(groups.filter(g => g.name === "nexahubtech")[0].items.length, 2)
  assert.strictEqual(groups.filter(g => g.name === "system")[0].dev, 0)

  // Projects with dev ports sort ahead of everything else.
  assert.ok(groups[0].dev > 0)
}

// ---------------------------------------------------------------- summary

{
  const stats = M.summary(rows)
  assert.strictEqual(stats.dev, 3)
  assert.strictEqual(stats.exposedDev, 0)
  assert.strictEqual(stats.exposed, 3)
  assert.strictEqual(M.hasProblem(stats, true), false)

  // Move the Vite server onto every interface and the widget goes urgent.
  const exposedProbe = probe.replace("[::1]:3000", "0.0.0.0:3000")
  const exposedStats = M.summary(M.buildRows(M.parseProbe(exposedProbe), { home: "/home/mich" }))
  assert.strictEqual(exposedStats.exposedDev, 1)
  assert.strictEqual(M.hasProblem(exposedStats, true), true)
  // Unless the user turned the warning off.
  assert.strictEqual(M.hasProblem(exposedStats, false), false)
  assert.ok(M.tooltip(exposedStats, true).indexOf("reachable from the network") > 0)

  assert.strictEqual(M.barText(stats, "Dev ports"), "3")
  assert.strictEqual(M.barText(stats, "All listening ports"), String(stats.total))
  assert.strictEqual(M.barText(stats, "Nothing"), "")
  assert.strictEqual(M.title(stats), "3 dev ports")
  assert.strictEqual(M.title(M.summary([])), "Ports")
  assert.ok(M.heroMeta(null, false).indexOf("reading") >= 0)
  assert.ok(M.tooltip(M.summary([]), true).indexOf("nothing listening") > 0)
}

// ---------------------------------------------------------------- actions

{
  assert.deepStrictEqual(M.killCommand(1234, "TERM"), ["kill", "-TERM", "1234"])
  assert.deepStrictEqual(M.killCommand(1234, "KILL"), ["kill", "-KILL", "1234"])
  assert.deepStrictEqual(M.killCommand(1234, "SIGINT"), ["kill", "-INT", "1234"])
  // Anything unrecognised falls back to the polite signal rather than
  // reaching the shell as-is.
  assert.deepStrictEqual(M.killCommand(1234, "; rm -rf /"), ["kill", "-TERM", "1234"])

  // Only your own processes, and never a row with no pid behind it.
  assert.strictEqual(M.killable(rowFor(3000), 1000), true)
  assert.strictEqual(M.killable(rowFor(3000), 0), false)
  assert.strictEqual(M.killable(rowFor(5432), 1000), false)

  // Every path to a shell is quoted, because a command line and a working
  // directory both come from another process.
  assert.strictEqual(M.openCommand("http://localhost:3000"), "xdg-open 'http://localhost:3000'")
  assert.ok(M.terminalCommand("/home/mich/a dir'; touch /tmp/pwned").indexOf("'\\''") > 0)
  assert.strictEqual(M.terminalCommand(""), "")
  assert.ok(M.copyCommand("a'b").indexOf("wl-copy") > 0)
}

// ---------------------------------------------------------------- text

{
  assert.strictEqual(M.formatDuration(45), "45s")
  assert.strictEqual(M.formatDuration(861), "14m")
  assert.strictEqual(M.formatDuration(17988), "4h 59m")
  assert.strictEqual(M.formatDuration(200000), "2d 7h")
  assert.strictEqual(M.formatCount(1, "port", "ports"), "1 port")
  assert.strictEqual(M.formatCount(0, "port", "ports"), "0 ports")
  assert.strictEqual(M.shortPath("/home/mich/Projects/x", "/home/mich"), "~/Projects/x")
  assert.strictEqual(M.shortPath("/etc/nginx", "/home/mich"), "/etc/nginx")
  assert.ok(M.elide("x".repeat(200), 40).length === 40)

  const meta = M.metaLine(rowFor(3000), "/home/mich")
  assert.ok(meta.indexOf("localhost") === 0)
  assert.ok(meta.indexOf("pid 586789") > 0)
  assert.ok(meta.indexOf("~/Projects/nexahubtech") > 0)

  // A deep working directory loses its head, not its tail: the end of the
  // path is the part that says which checkout this is.
  assert.strictEqual(M.capPath("~/Projects/DistressNowApi/public", 30), "…/DistressNowApi/public")
  assert.strictEqual(M.capPath("~/Projects/x", 30), "~/Projects/x")
  assert.ok(M.metaLine(rowFor(8000), "/home/mich").indexOf("…/DistressNowApi/public") > 0)
  assert.ok(M.metaLine(rowFor(5432), "/home/mich").indexOf("another user") > 0)

  // Every filter needs a label and something to say when it is empty, or a
  // chip opens a blank panel.
  M.filterIds().forEach(function (id) {
    assert.ok(M.filterLabel(id).length > 0, id)
    assert.ok(M.emptyText(id).length > 0, id)
  })
  assert.ok(M.killMessage([rowFor(3000)]).indexOf("3000") > 0)
  assert.ok(M.killMessage([rowFor(3000), rowFor(8000)]).indexOf("2 processes") > 0)
}

// ------------------------------------------------------- markup in /proc
//
// A process names its own comm, argv, and working directory, and Qt's Text
// defaults to AutoText — it parses anything tag-shaped as rich text and
// fetches whatever an <img> in it points at. The rows pin
// textFormat: Text.PlainText; the two sinks that cannot be pinned are
// covered by plainText() instead.
{
  assert.strictEqual(M.plainText('<img src="http://evil/x">'), 'img src="http://evil/x"')
  assert.strictEqual(M.plainText("<b>bold</b>"), "bbold/b")
  assert.strictEqual(M.plainText(""), "")
  assert.strictEqual(M.plainText(null), "")
  assert.strictEqual(M.plainText(undefined), "")
  // No angle bracket survives, so nothing downstream can look like a tag.
  assert.ok(M.plainText("<!DOCTYPE html><html>").indexOf("<") < 0)

  // The confirm dialog is the sink that cannot be pinned, so a hostile
  // process name has to come out clean there.
  const hostile = M.buildRows(M.parseProbe([
    "SELF\t1000",
    "SSRC\t0",
    'SOCK\tLISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("x",pid=999,fd=3))',
    'PROC\t999\t1000\t<img src="http://evil/x">\t/home/mich/p\t10\t/home/mich/p\tserver'
  ].join("\n")), { home: "/home/mich" })
  const message = M.killMessage(hostile)
  assert.ok(message.indexOf("<") < 0, message)
  assert.ok(message.indexOf(">") < 0, message)

  // A path with a shell redirect in it is still shown as written, because
  // the rows that carry it are pinned rather than stripped.
  assert.ok(M.metaLine(rowFor(3000), "/home/mich").indexOf("~/Projects/nexahubtech") > 0)
}

console.log("ok — model tests passed")
