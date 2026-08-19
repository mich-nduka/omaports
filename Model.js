// Pure helpers for the omaports bar widget: everything that turns one `ss`
// dump plus a walk of /proc into the rows the panel draws. No Qt in here, so
// `node test/model-test.js` exercises the whole parser, classifier, filter,
// grouping and formatting engine directly.

// ---------------------------------------------------------------- constants

var FILTERS = ["dev", "mine", "exposed", "all"]

// Ports a developer machine hands to project servers. Membership makes a
// port "dev" on its own, because the process behind it is often invisible:
// a container publishes 3000 and all this user can see is the port.
var DEV_PORT_RANGES = [
  [1313, 1313],   // hugo
  [3000, 3010],   // node, rails, next, remix
  [3333, 3333],   // nx
  [4000, 4010],   // phoenix, jekyll
  [4200, 4200],   // angular
  [4321, 4321],   // astro
  [5000, 5010],   // flask, .net
  [5173, 5180],   // vite
  [7000, 7010],   // misc
  [8000, 8010],   // django, php, uvicorn
  [8080, 8090],   // tomcat, proxies, generic
  [8100, 8100],   // ionic
  [8888, 8888],   // jupyter
  [9000, 9010],   // php-fpm, sonar, generic
  [19000, 19010], // expo
  [24678, 24678], // vite hmr
  [54321, 54324]  // supabase
]

// Ports whose owner is worth naming even when the process belongs to another
// user — which is the normal case for a database or a system daemon, since
// `ss` only names processes this user owns. `http` decides whether the panel
// offers to open the port in a browser.
var WELL_KNOWN = {
  22: { name: "SSH", http: false },
  25: { name: "SMTP", http: false },
  53: { name: "DNS", http: false },
  80: { name: "HTTP", http: true },
  111: { name: "rpcbind", http: false },
  443: { name: "HTTPS", http: true },
  631: { name: "CUPS", http: true },
  1025: { name: "Mailhog SMTP", http: false },
  1080: { name: "Mailcatcher", http: true },
  1883: { name: "MQTT", http: false },
  2375: { name: "Docker", http: false },
  3306: { name: "MySQL", http: false },
  3389: { name: "RDP", http: false },
  4873: { name: "Verdaccio", http: true },
  5433: { name: "PostgreSQL", http: false },
  5432: { name: "PostgreSQL", http: false },
  5672: { name: "RabbitMQ", http: false },
  5900: { name: "VNC", http: false },
  6379: { name: "Redis", http: false },
  8025: { name: "Mailpit", http: true },
  8086: { name: "InfluxDB", http: true },
  9092: { name: "Kafka", http: false },
  9090: { name: "Prometheus", http: true },
  9200: { name: "Elasticsearch", http: true },
  11211: { name: "Memcached", http: false },
  11434: { name: "Ollama", http: true },
  15672: { name: "RabbitMQ admin", http: true },
  27017: { name: "MongoDB", http: false }
}

// What the command line says it is. First match wins, so the specific
// frameworks come before the runtimes that host them — "next dev" is a Next
// server before it is a node process.
var RUNTIMES = [
  { re: /next-server|\bnext\b/, name: "Next.js" },
  { re: /\bnuxt\b/, name: "Nuxt" },
  { re: /\bastro\b/, name: "Astro" },
  { re: /\bremix\b/, name: "Remix" },
  { re: /\bsveltekit\b|\bsvelte\b/, name: "Svelte" },
  { re: /\bvite\b/, name: "Vite" },
  { re: /storybook/, name: "Storybook" },
  { re: /react-scripts/, name: "React" },
  { re: /@angular|\bng\b\s+serve/, name: "Angular" },
  { re: /webpack/, name: "webpack" },
  { re: /\bexpo\b/, name: "Expo" },
  { re: /\bdeno\b/, name: "Deno" },
  { re: /\bbun\b/, name: "Bun" },
  { re: /\bnode\b|\bnodemon\b/, name: "Node" },
  { re: /artisan\s+serve/, name: "Laravel" },
  { re: /\bphp\b/, name: "PHP" },
  { re: /manage\.py|\bdjango\b/, name: "Django" },
  { re: /uvicorn/, name: "Uvicorn" },
  { re: /gunicorn/, name: "Gunicorn" },
  { re: /\bflask\b/, name: "Flask" },
  { re: /http\.server|SimpleHTTPServer/, name: "Python http.server" },
  { re: /\bpython[0-9.]*\b/, name: "Python" },
  { re: /\bpuma\b|\brails\b|\bpassenger\b/, name: "Rails" },
  { re: /\bcargo\b/, name: "Cargo" },
  { re: /\bair\b|\bgo\s+run\b/, name: "Go" },
  { re: /dotnet/, name: ".NET" },
  { re: /gradle|\bjava\b|\bmvn\b/, name: "JVM" },
  { re: /\bhugo\b/, name: "Hugo" },
  { re: /\bjekyll\b/, name: "Jekyll" },
  { re: /docker-proxy|containerd/, name: "Docker" },
  { re: /supabase/, name: "Supabase" }
]

// Directories that name nothing. A server started from the home directory
// belongs to no project, and saying "mich" would be worse than saying nothing.
var UNPROJECT = { "/": true, "/tmp": true, "/usr": true, "/var": true, "/etc": true, "/root": true, "/home": true }

// ---------------------------------------------------------------- probe

// One shell round trip for the whole panel: the listening sockets, then the
// /proc facts for every pid behind them. `$1` is "udp" when UDP is wanted.
//
// The enrichment is the point. `ss` reports a process by its comm, which for
// a threaded runtime is whatever the thread was named — "MainThread" for a
// Python server, "node" for every JavaScript project on the machine. The
// command line says which framework it is and the working directory says
// which project, and both are readable for your own processes without any
// privilege at all.
function probeScript() {
  return [
    'printf "SELF\\t%s\\n" "$(id -u)"',
    'socks=$(ss -tlnpH 2>/dev/null); rc=$?',
    'if [ "${1:-}" = "udp" ]; then',
    '  socks="$socks',
    '$(ss -ulnpH 2>/dev/null)"',
    'fi',
    'printf "SSRC\\t%s\\n" "$rc"',
    'printf "%s\\n" "$socks" | while IFS= read -r line; do',
    '  [ -n "$line" ] || continue',
    '  printf "SOCK\\t%s\\n" "$line"',
    'done',
    'pids=$(printf "%s\\n" "$socks" | tr "," "\\n" | sed -n "s/.*pid=\\([0-9][0-9]*\\).*/\\1/p" | sort -un)',
    'for pid in $pids; do',
    '  [ -r "/proc/$pid/status" ] || continue',
    '  comm=$(tr -d "\\n" < "/proc/$pid/comm" 2>/dev/null)',
    '  uid=$(awk "/^Uid:/{print \\$2; exit}" "/proc/$pid/status" 2>/dev/null)',
    '  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null)',
    '  cmd=$(tr "\\0\\t\\n" "   " < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-400)',
    '  age=$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d " ")',
    // The checkout the server was started from, not the directory it happens
    // to be sitting in: a Laravel server runs from `public/` and a monorepo
    // dev server from `packages/web`, and only one of those two is a name a
    // person would recognise in a list.
    '  root=""; d="$cwd"',
    '  while [ -n "$d" ] && [ "$d" != "/" ] && [ "$d" != "$HOME" ]; do',
    '    for m in .git package.json Cargo.toml go.mod composer.json pyproject.toml Gemfile mix.exs pom.xml build.gradle deno.json; do',
    '      if [ -e "$d/$m" ]; then root="$d"; break; fi',
    '    done',
    '    [ -n "$root" ] && break',
    '    d=$(dirname "$d")',
    '  done',
    '  printf "PROC\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$pid" "${uid:-}" "$comm" "$cwd" "${age:-0}" "$root" "$cmd"',
    'done'
  ].join('\n')
}

// ---------------------------------------------------------------- parsing

// `ss -H` prints: state, recv-q, send-q, local, peer, and an optional
// users:((...)) tail. Pulling the tail off first is what keeps the column
// split honest, because the tail is the only field that can contain spaces.
function parseSocketLine(line, proto) {
  var text = String(line || "").trim()
  if (!text) return null

  var users = []
  var usersAt = text.indexOf("users:(")
  if (usersAt >= 0) {
    users = parseUsers(text.substring(usersAt))
    text = text.substring(0, usersAt).trim()
  }

  var cols = text.split(/\s+/)
  if (cols.length < 4) return null

  var where = splitHostPort(cols[3])
  if (!where) return null

  return {
    proto: String(proto || "tcp"),
    state: cols[0],
    addr: where.host,
    port: where.port,
    users: users
  }
}

// users:(("node",pid=1234,fd=21),("node",pid=1235,fd=21))
function parseUsers(text) {
  var out = []
  var re = /\("([^"]*)",pid=(\d+)/g
  var match
  while ((match = re.exec(String(text || "")))) {
    out.push({ name: match[1], pid: parseInt(match[2], 10) })
  }
  return out
}

// 127.0.0.1:8000, [::1]:3000, *:8080, 127.0.0.53%lo:53 — the last colon is
// the separator in every one of them once the brackets come off.
function splitHostPort(token) {
  var text = String(token || "").trim()
  if (!text) return null

  var cut = text.lastIndexOf(":")
  if (cut < 0) return null

  var host = text.substring(0, cut)
  var port = parseInt(text.substring(cut + 1), 10)
  if (!isFinite(port) || port <= 0) return null

  host = host.replace(/^\[|\]$/g, "")
  // A link-local address carries the interface it is scoped to; the address
  // is what matters here.
  var scoped = host.indexOf("%")
  if (scoped >= 0) host = host.substring(0, scoped)

  return { host: host, port: port }
}

function parseProbe(text) {
  var lines = String(text || "").split("\n")
  var out = { selfUid: -1, sockets: [], procs: {}, ok: false }
  var proto = "tcp"

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (!line) continue

    var tab = line.indexOf("\t")
    if (tab < 0) continue

    var tag = line.substring(0, tab)
    var rest = line.substring(tab + 1)

    if (tag === "SELF") {
      out.selfUid = parseInt(rest, 10)
      if (!isFinite(out.selfUid)) out.selfUid = -1
      continue
    }

    if (tag === "SSRC") {
      // ss's own exit code, so an empty list is told apart from a failed
      // probe. "Nothing is listening" and "nothing answered" are different
      // sentences and the panel says whichever is true.
      out.ok = parseInt(rest, 10) === 0
      continue
    }

    if (tag === "SOCK") {
      // The two `ss` calls are concatenated, so the state word is what tells
      // them apart: LISTEN is TCP, UNCONN is the UDP half.
      proto = /^UNCONN\b/.test(rest) ? "udp" : "tcp"
      var sock = parseSocketLine(rest, proto)
      if (sock) out.sockets.push(sock)
      continue
    }

    if (tag === "PROC") {
      var cols = rest.split("\t")
      if (cols.length < 7) continue
      var pid = parseInt(cols[0], 10)
      if (!isFinite(pid)) continue
      out.procs[pid] = {
        pid: pid,
        uid: parseInt(cols[1], 10),
        comm: cols[2] || "",
        cwd: cols[3] || "",
        ageSec: parseInt(cols[4], 10) || 0,
        root: cols[5] || "",
        cmdline: String(cols[6] || "").trim()
      }
    }
  }

  return out
}

// ---------------------------------------------------------------- ranges

// "3000, 4000-4010 8080" — commas, spaces, and ranges, because a port list
// typed into a settings field arrives in whichever of those a person likes.
function parsePortList(text) {
  var parts = String(text || "").split(/[,\s]+/)
  var out = []

  for (var i = 0; i < parts.length; i++) {
    var part = parts[i].trim()
    if (!part) continue

    var range = /^(\d+)\s*-\s*(\d+)$/.exec(part)
    if (range) {
      var from = parseInt(range[1], 10)
      var to = parseInt(range[2], 10)
      if (isFinite(from) && isFinite(to) && to >= from) out.push([from, to])
      continue
    }

    var one = parseInt(part, 10)
    if (isFinite(one) && one > 0) out.push([one, one])
  }

  return out
}

function inRanges(port, ranges) {
  var n = Number(port)
  var list = ranges || []
  for (var i = 0; i < list.length; i++) {
    if (n >= list[i][0] && n <= list[i][1]) return true
  }
  return false
}

// ---------------------------------------------------------------- rows

function isLoopback(addr) {
  var text = String(addr || "")
  return text === "::1" || text === "127.0.0.1" || /^127\./.test(text)
}

function isAnyAddress(addr) {
  var text = String(addr || "")
  return text === "0.0.0.0" || text === "::" || text === "*"
}

// The one thing about a dev port that can bite: whether the rest of the
// network can reach it. Loopback is yours alone; anything else is not.
function scopeOf(addrs) {
  var list = addrs || []
  var any = false
  var iface = false

  for (var i = 0; i < list.length; i++) {
    if (isAnyAddress(list[i])) any = true
    else if (!isLoopback(list[i])) iface = true
  }

  if (any) return "any"
  if (iface) return "iface"
  return "loopback"
}

function scopeLabel(scope) {
  if (scope === "any") return "all interfaces"
  if (scope === "iface") return "one interface"
  return "localhost"
}

function runtimeOf(cmdline, comm) {
  var text = (String(cmdline || "") + " " + String(comm || "")).toLowerCase()
  if (!text.trim()) return ""

  for (var i = 0; i < RUNTIMES.length; i++) {
    if (RUNTIMES[i].re.test(text)) return RUNTIMES[i].name
  }
  return ""
}

// The checkout a server belongs to, which is the closest thing to a project
// name that exists without asking the user to configure one. `root` is the
// nearest ancestor of the working directory carrying a project marker; the
// working directory itself is the fallback for a server started somewhere
// with no marker at all.
function projectOf(cwd, home, root) {
  var dir = String(root || cwd || "").replace(/\/+$/, "")
  if (!dir) return ""
  if (UNPROJECT[dir]) return ""
  if (home && dir === String(home).replace(/\/+$/, "")) return ""

  var cut = dir.lastIndexOf("/")
  var name = cut >= 0 ? dir.substring(cut + 1) : dir
  return name === "" ? "" : name
}

function serviceOf(port) {
  var known = WELL_KNOWN[Number(port)]
  return known ? known.name : ""
}

// A port is a dev port when it sits in the range a dev server would take,
// when the process behind it is a dev runtime, or when the user said so.
// A well-known service port is not, unless the user named it — Postgres on
// 5432 is infrastructure, and lumping it in with the thing you are building
// makes the count useless.
function isDevPort(row, extraRanges) {
  if (inRanges(row.port, extraRanges)) return true
  if (row.runtime) return true
  if (WELL_KNOWN[row.port] && !row.runtime) return false
  return inRanges(row.port, DEV_PORT_RANGES)
}

// Whether a browser is the right thing to point at this port. Known non-web
// services say no outright; everything else that looks like a dev server is
// worth a try, since guessing wrong costs one browser tab.
function isHttp(row, httpsRanges) {
  if (inRanges(row.port, httpsRanges)) return true
  var known = WELL_KNOWN[row.port]
  if (known) return known.http === true
  if (row.proto === "udp") return false
  return row.dev
}

function urlFor(row, httpsRanges) {
  if (!row || !row.http) return ""
  var scheme = inRanges(row.port, httpsRanges) || row.port === 443 ? "https" : "http"
  return scheme + "://localhost:" + row.port
}

// Sockets collapse into one row per listener. A dev server that binds both
// 127.0.0.1 and ::1 is one server, and showing it twice would double every
// count in the panel.
function rowKey(sock, user) {
  if (user && user.pid) return "p" + user.pid + "/" + sock.proto + "/" + sock.port
  return "x/" + sock.proto + "/" + sock.port
}

function buildRows(parsed, options) {
  var opts = options || {}
  var extraRanges = opts.devPorts || []
  var ignoreRanges = opts.ignorePorts || []
  var httpsRanges = opts.httpsPorts || []
  var selfUid = parsed && isFinite(parsed.selfUid) ? parsed.selfUid : -1
  var sockets = (parsed && parsed.sockets) || []
  var procs = (parsed && parsed.procs) || {}

  var byKey = {}
  var order = []

  for (var i = 0; i < sockets.length; i++) {
    var sock = sockets[i]
    if (inRanges(sock.port, ignoreRanges)) continue

    var users = sock.users && sock.users.length ? sock.users : [null]
    for (var u = 0; u < users.length; u++) {
      var user = users[u]
      var key = rowKey(sock, user)
      var row = byKey[key]

      if (!row) {
        var proc = user && procs[user.pid] ? procs[user.pid] : null
        row = {
          kind: "port",
          key: key,
          port: sock.port,
          proto: sock.proto,
          addrs: [],
          pid: user ? user.pid : 0,
          comm: proc ? proc.comm : (user ? user.name : ""),
          cmdline: proc ? proc.cmdline : "",
          cwd: proc ? proc.cwd : "",
          uid: proc && isFinite(proc.uid) ? proc.uid : -1,
          ageSec: proc ? proc.ageSec : 0
        }
        row.mine = row.pid > 0 && row.uid >= 0 && row.uid === selfUid
        row.runtime = runtimeOf(row.cmdline, row.comm)
        row.project = projectOf(row.cwd, opts.home, proc ? proc.root : "")
        row.service = serviceOf(row.port)
        byKey[key] = row
        order.push(key)
      }

      if (row.addrs.indexOf(sock.addr) < 0) row.addrs.push(sock.addr)
    }
  }

  var rows = []
  for (var k = 0; k < order.length; k++) {
    var item = byKey[order[k]]
    item.scope = scopeOf(item.addrs)
    item.exposed = item.scope !== "loopback"
    item.dev = isDevPort(item, extraRanges)
    item.http = isHttp(item, httpsRanges)
    item.url = urlFor(item, httpsRanges)
    item.problem = item.exposed && item.dev
    rows.push(item)
  }

  rows.sort(function (a, b) {
    if (a.port !== b.port) return a.port - b.port
    return a.proto < b.proto ? -1 : a.proto > b.proto ? 1 : 0
  })

  return rows
}

// ---------------------------------------------------------------- keys

function resourceKey(item) {
  return item && item.key ? String(item.key) : ""
}

// ---------------------------------------------------------------- filtering

function filterIds() {
  return FILTERS.slice()
}

function defaultFilter() {
  return "dev"
}

function filterLabel(filter) {
  if (filter === "dev") return "dev"
  if (filter === "mine") return "mine"
  if (filter === "exposed") return "exposed"
  return "all"
}

function matchesFilter(item, filter) {
  if (!item) return false
  if (filter === "dev") return item.dev === true
  if (filter === "mine") return item.mine === true
  if (filter === "exposed") return item.exposed === true
  return true
}

function filterBy(list, filter) {
  var rows = list || []
  var out = []
  for (var i = 0; i < rows.length; i++) {
    if (matchesFilter(rows[i], filter)) out.push(rows[i])
  }
  return out
}

function haystack(item) {
  if (!item) return ""
  return [
    item.port,
    item.proto,
    item.comm,
    item.runtime,
    item.service,
    item.project,
    item.cwd,
    item.cmdline,
    item.pid,
    scopeLabel(item.scope)
  ].join(" ").toLowerCase()
}

function searchBy(list, queryText) {
  var needle = String(queryText || "").trim().toLowerCase()
  var rows = list || []
  if (!needle) return rows.slice()

  var terms = needle.split(/\s+/)
  var out = []

  for (var i = 0; i < rows.length; i++) {
    var hay = haystack(rows[i])
    var all = true
    for (var t = 0; t < terms.length; t++) {
      if (hay.indexOf(terms[t]) < 0) { all = false; break }
    }
    if (all) out.push(rows[i])
  }

  return out
}

// ---------------------------------------------------------------- grouping

// A project directory is the most useful heading there is: it answers "what
// is on 3000" with the name of the checkout rather than the word "node".
function groupNameFor(item) {
  if (!item) return "system"
  if (item.project) return item.project
  if (item.runtime) return item.runtime
  if (item.mine && item.comm) return item.comm
  // A daemon owned by another user is named on its own row already; giving
  // each one a heading of its own would turn the panel into a list of
  // one-row groups. They belong together under the one heading nobody needs
  // to read.
  return "system"
}

function groupItems(list) {
  var rows = list || []
  var byName = {}
  var order = []

  for (var i = 0; i < rows.length; i++) {
    var name = groupNameFor(rows[i])
    if (!byName[name]) {
      byName[name] = { name: name, items: [], dev: 0, exposed: 0, total: 0 }
      order.push(name)
    }
    var group = byName[name]
    group.items.push(rows[i])
    group.total++
    if (rows[i].dev) group.dev++
    if (rows[i].exposed) group.exposed++
  }

  var groups = []
  for (var g = 0; g < order.length; g++) groups.push(byName[order[g]])

  // Projects you are working on first, "system" always last, alphabetical
  // within each band so the list does not reshuffle between polls.
  groups.sort(function (a, b) {
    if ((a.name === "system") !== (b.name === "system")) return a.name === "system" ? 1 : -1
    if ((a.dev > 0) !== (b.dev > 0)) return a.dev > 0 ? -1 : 1
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })

  return groups
}

// ---------------------------------------------------------------- formatting

function formatDuration(seconds) {
  var total = Math.max(0, Math.floor(Number(seconds) || 0))
  if (total < 60) return total + "s"
  if (total < 3600) return Math.floor(total / 60) + "m"
  if (total < 86400) return Math.floor(total / 3600) + "h " + Math.floor((total % 3600) / 60) + "m"
  return Math.floor(total / 86400) + "d " + Math.floor((total % 86400) / 3600) + "h"
}

function formatCount(n, singular, plural) {
  var count = Math.max(0, Math.floor(Number(n) || 0))
  return count + " " + (count === 1 ? singular : plural)
}

function elide(text, max) {
  var value = String(text || "").replace(/\s+/g, " ").trim()
  var limit = Number(max) || 120
  return value.length > limit ? value.substring(0, limit - 1) + "…" : value
}

// A path is more readable with the home directory folded away, and shorter
// too, which matters in a row that also has to hold a port and a runtime.
function shortPath(path, home) {
  var value = String(path || "")
  var base = String(home || "").replace(/\/+$/, "")
  if (base && value.indexOf(base + "/") === 0) return "~" + value.substring(base.length)
  if (base && value === base) return "~"
  return value
}

// A deep path trimmed from the left, because the end of a path is the part
// that identifies it. A row has one line for this and the port has to fit
// on it too.
function capPath(path, max) {
  var value = String(path || "")
  var limit = Number(max) || 30
  if (value.length <= limit) return value

  var parts = value.split("/")
  var out = parts[parts.length - 1]
  for (var i = parts.length - 2; i > 0; i--) {
    var next = parts[i] + "/" + out
    if (next.length + 2 > limit) break
    out = next
  }
  return "…/" + out
}

// ---------------------------------------------------------------- labels

// What the row calls the thing holding the port. The runtime beats the comm
// because "Next.js" is the answer and "MainThread" is not.
function displayName(item) {
  if (!item) return ""
  if (item.runtime) return item.runtime
  if (item.service) return item.service
  if (item.comm) return item.comm
  return ""
}

function primaryLabel(item) {
  if (!item) return ""
  var name = displayName(item)
  var port = String(item.port) + (item.proto === "udp" ? "/udp" : "")
  return name ? port + "  ·  " + name : port
}

// Ordered by what a person reading one row wants first: whether the port is
// only theirs, then which checkout it belongs to. The pid comes last because
// it only matters once you have decided to kill something, and it is the
// part a narrow panel can afford to elide.
function metaLine(item, home) {
  if (!item) return ""
  var parts = []

  parts.push(scopeLabel(item.scope))
  if (item.cwd) parts.push(capPath(shortPath(item.cwd, home), 30))
  else if (item.cmdline) parts.push(elide(item.cmdline, 40))
  else if (!item.mine && item.pid === 0) parts.push("another user")
  if (item.ageSec > 0) parts.push("up " + formatDuration(item.ageSec))
  if (item.pid > 0) parts.push("pid " + item.pid)

  return parts.join(" · ")
}

function copyText(item) {
  if (!item) return ""
  if (item.url) return item.url
  return "localhost:" + item.port
}

function searchPlaceholder() {
  return "Filter by port, project, or process…"
}

function emptyText(filter) {
  if (filter === "dev") return "Nothing dev-shaped is listening. Start a server and it lands here."
  if (filter === "mine") return "None of your own processes are listening."
  if (filter === "exposed") return "Nothing is reachable beyond localhost. That is the good answer."
  return "Nothing is listening on this machine."
}

function noMatchText() {
  return "No port matches that."
}

// ---------------------------------------------------------------- summary

function summary(rows) {
  var list = rows || []
  var out = { total: 0, dev: 0, mine: 0, exposed: 0, exposedDev: 0, http: 0 }

  for (var i = 0; i < list.length; i++) {
    var row = list[i]
    out.total++
    if (row.dev) out.dev++
    if (row.mine) out.mine++
    if (row.exposed) out.exposed++
    if (row.exposed && row.dev) out.exposedDev++
    if (row.http) out.http++
  }

  return out
}

// The icon goes urgent for the one thing worth interrupting someone over: a
// dev server that the rest of the network can reach.
function hasProblem(stats, warnExposed) {
  if (!stats) return false
  return warnExposed !== false && stats.exposedDev > 0
}

function barText(stats, mode) {
  if (!stats) return ""
  if (mode === "Nothing") return ""
  if (mode === "All listening ports") return String(stats.total)
  return String(stats.dev)
}

function title(stats) {
  if (!stats || stats.total === 0) return "Ports"
  if (stats.dev === 0) return "Ports"
  return formatCount(stats.dev, "dev port", "dev ports")
}

function heroMeta(stats, ready) {
  if (!ready) return "reading listening sockets…"
  if (!stats || stats.total === 0) return "nothing is listening"
  if (stats.exposedDev > 0) {
    return formatCount(stats.exposedDev, "dev port is", "dev ports are") + " open to the network"
  }
  return formatCount(stats.total, "port", "ports") + " listening · " + stats.mine + " yours"
}

function tooltip(stats, ready) {
  if (!ready) return "Ports — reading"
  if (!stats || stats.total === 0) return "Ports — nothing listening"

  var lines = [formatCount(stats.dev, "dev port", "dev ports") + " of " + stats.total + " listening"]
  if (stats.exposedDev > 0) {
    lines.push(formatCount(stats.exposedDev, "dev port", "dev ports") + " reachable from the network")
  } else if (stats.exposed > 0) {
    lines.push(formatCount(stats.exposed, "port", "ports") + " beyond localhost")
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------- actions

// SIGTERM asks; SIGKILL does not. Both go to the pid `ss` reported, which is
// the process holding the socket rather than whatever started it — killing
// the parent would leave the port held.
function killCommand(pid, signal) {
  var name = String(signal || "TERM").toUpperCase().replace(/^SIG/, "")
  if (["TERM", "INT", "HUP", "KILL"].indexOf(name) < 0) name = "TERM"
  return ["kill", "-" + name, String(pid)]
}

function shQuote(value) {
  return "'" + String(value === undefined || value === null ? "" : value).replace(/'/g, "'\\''") + "'"
}

function openCommand(url) {
  return "xdg-open " + shQuote(url)
}

function copyCommand(text) {
  return "printf %s " + shQuote(text) + " | wl-copy"
}

// A terminal already sitting in the project the port belongs to, which is
// where you were heading anyway.
function terminalCommand(dir) {
  var path = String(dir || "").trim()
  if (!path) return ""
  return "cd " + shQuote(path) + " && xdg-terminal-exec"
}

function killable(item, selfUid) {
  if (!item || !item.pid) return false
  if (!isFinite(selfUid) || selfUid < 0) return item.mine === true
  return item.uid === selfUid
}

function killMessage(items) {
  var list = items || []
  if (list.length === 1) {
    return "Kill " + displayName(list[0]) + " on port " + list[0].port + "?"
  }
  return "Kill " + list.length + " processes?"
}

// ---------------------------------------------------------------- exports
//
// Nothing here touches Qt, so the whole file also loads under node and the
// tests in test/model-test.js exercise it directly. QML's .js import ignores
// this block.
if (typeof module !== "undefined") {
  module.exports = {
    FILTERS: FILTERS,
    DEV_PORT_RANGES: DEV_PORT_RANGES,
    WELL_KNOWN: WELL_KNOWN,
    probeScript: probeScript,
    parseSocketLine: parseSocketLine,
    parseUsers: parseUsers,
    splitHostPort: splitHostPort,
    parseProbe: parseProbe,
    parsePortList: parsePortList,
    inRanges: inRanges,
    isLoopback: isLoopback,
    isAnyAddress: isAnyAddress,
    scopeOf: scopeOf,
    scopeLabel: scopeLabel,
    runtimeOf: runtimeOf,
    projectOf: projectOf,
    serviceOf: serviceOf,
    isDevPort: isDevPort,
    isHttp: isHttp,
    urlFor: urlFor,
    buildRows: buildRows,
    resourceKey: resourceKey,
    filterIds: filterIds,
    defaultFilter: defaultFilter,
    filterLabel: filterLabel,
    matchesFilter: matchesFilter,
    filterBy: filterBy,
    searchBy: searchBy,
    groupNameFor: groupNameFor,
    groupItems: groupItems,
    formatDuration: formatDuration,
    formatCount: formatCount,
    elide: elide,
    shortPath: shortPath,
    capPath: capPath,
    displayName: displayName,
    primaryLabel: primaryLabel,
    metaLine: metaLine,
    copyText: copyText,
    searchPlaceholder: searchPlaceholder,
    emptyText: emptyText,
    noMatchText: noMatchText,
    summary: summary,
    hasProblem: hasProblem,
    barText: barText,
    title: title,
    heroMeta: heroMeta,
    tooltip: tooltip,
    killCommand: killCommand,
    shQuote: shQuote,
    openCommand: openCommand,
    copyCommand: copyCommand,
    terminalCommand: terminalCommand,
    killable: killable,
    killMessage: killMessage
  }
}
