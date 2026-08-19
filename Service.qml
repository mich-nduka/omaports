import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import "Model.js" as Model

// Everything that runs a process. The panel never starts one itself, so the
// bar icon stays honest with the panel closed.
//
// One probe answers the whole widget: `ss` for the listening sockets, then
// /proc for the command line, working directory, project root, and age of
// every pid behind them. That second half is what turns "node, pid 586789"
// into "Vite, nexahubtech" — and it costs nothing, because a process you
// own is fully readable to you.
Item {
  id: root

  property var settings: ({})
  property bool panelOpen: false

  readonly property string home: Quickshell.env("HOME") || ""

  property bool installed: true
  property bool ready: false
  property bool reachable: false
  property bool refreshing: false

  property var rows: []
  property var stats: Model.summary([])
  property int selfUid: -1

  property bool hasProblem: false
  property string lastError: ""
  property string actionStatus: ""
  property var pendingKeys: ({})

  readonly property int refreshIntervalSec: intSetting("refreshIntervalSec", 5, 2, 300)
  readonly property bool includeUdp: setting("includeUdp", false) === true
  readonly property bool showSystemPorts: setting("showSystemPorts", true) !== false
  readonly property bool warnExposed: setting("warnExposed", true) !== false
  readonly property bool confirmKill: setting("confirmKill", true) !== false
  readonly property string killSignal: String(setting("killSignal", "TERM") || "TERM")
  readonly property string barLabelMode: String(setting("barLabel", "Dev ports"))

  readonly property var devRanges: Model.parsePortList(setting("devPorts", ""))
  readonly property var ignoreRanges: Model.parsePortList(setting("ignorePorts", ""))
  readonly property var httpsRanges: Model.parsePortList(setting("httpsPorts", ""))

  // ------------------------------------------------------------- settings

  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null ? fallback : value
  }

  function intSetting(name, fallback, min, max) {
    var n = parseInt(String(setting(name, fallback)), 10)
    if (!isFinite(n)) n = fallback
    if (n < min) n = min
    if (n > max) n = max
    return n
  }

  // ------------------------------------------------------------- polling

  function refresh() {
    if (probe.running) return
    refreshing = true
    probe.command = ["/bin/sh", "-c", Model.probeScript(), "sh", includeUdp ? "udp" : "tcp"]
    probe.running = true
    watchdog.restart()
  }

  function applyProbe(exitCode, stdout, stderr) {
    refreshing = false
    watchdog.stop()

    var parsed = Model.parseProbe(stdout)
    if (exitCode !== 0 || !parsed.ok) {
      installed = exitCode !== 127
      reachable = false
      lastError = Model.elide(stderr || "ss did not answer", 90)
      rows = []
      stats = Model.summary([])
      hasProblem = false
      ready = true
      return
    }

    installed = true
    reachable = true
    lastError = ""
    selfUid = parsed.selfUid

    var built = Model.buildRows(parsed, {
      home: root.home,
      devPorts: root.devRanges,
      ignorePorts: root.ignoreRanges,
      httpsPorts: root.httpsRanges
    })

    if (!showSystemPorts) {
      var kept = []
      for (var i = 0; i < built.length; i++) {
        if (built[i].mine || built[i].dev) kept.push(built[i])
      }
      built = kept
    }

    rows = built
    stats = Model.summary(built)
    hasProblem = Model.hasProblem(stats, warnExposed)
    ready = true
    prunePending()
  }

  // A row killed between polls should stop looking pending the moment it is
  // gone, rather than waiting for a timer nobody set.
  function prunePending() {
    var live = {}
    var i
    for (i = 0; i < rows.length; i++) live[Model.resourceKey(rows[i])] = true

    var next = {}
    var changed = false
    for (var key in pendingKeys) {
      if (!pendingKeys[key]) continue
      if (live[key]) next[key] = true
      else changed = true
    }
    if (changed) pendingKeys = next
  }

  function abortProbe() {
    if (probe.running) probe.running = false
    refreshing = false
    lastError = "The socket table did not answer in time."
  }

  onPanelOpenChanged: if (panelOpen) refresh()
  onIncludeUdpChanged: refresh()

  // ------------------------------------------------------------- actions

  function markPending(items) {
    var next = {}
    var key
    for (key in pendingKeys) if (pendingKeys[key]) next[key] = true
    for (var i = 0; i < (items || []).length; i++) {
      key = Model.resourceKey(items[i])
      if (key) next[key] = true
    }
    pendingKeys = next
  }

  // One `kill` per process, because the panel's selection can span several
  // and a single failure should not take the rest of them down with it.
  function killRows(items, force) {
    var list = items || []
    if (!list.length) return

    var signal = force ? "KILL" : killSignal
    var sent = 0
    var refused = 0

    for (var i = 0; i < list.length; i++) {
      var item = list[i]
      if (!Model.killable(item, selfUid)) { refused++; continue }
      Quickshell.execDetached(Model.killCommand(item.pid, signal))
      sent++
    }

    markPending(list)
    if (sent > 0) {
      actionStatus = "Sent SIG" + signal + " to " + Model.formatCount(sent, "process", "processes") + "."
    }
    if (refused > 0) {
      actionStatus = Model.formatCount(refused, "port is", "ports are") + " not yours to kill."
    }
    statusTimer.restart()
    // A shutting-down server takes a moment to let go of its socket, so ask
    // twice: once for a quick exit, once for a slow one.
    settleTimer.restart()
    lateSettleTimer.restart()
  }

  function openUrl(url) {
    var link = String(url || "").trim()
    if (!link) return
    Util.execDetached(Model.openCommand(link))
    actionStatus = "Opened " + link
    statusTimer.restart()
  }

  function copyToClipboard(text) {
    var value = String(text || "")
    if (!value) return
    Util.execDetached(Model.copyCommand(value))
    actionStatus = "Copied to the clipboard."
    statusTimer.restart()
  }

  function openTerminal(dir) {
    var command = Model.terminalCommand(dir)
    if (!command) return
    Util.execDetached(command)
    actionStatus = "Opened a terminal in " + Model.shortPath(dir, home)
    statusTimer.restart()
  }

  // ------------------------------------------------------------- processes

  Timer {
    id: refreshTimer
    interval: root.refreshIntervalSec * 1000
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  Timer {
    id: settleTimer
    interval: 400
    onTriggered: root.refresh()
  }

  Timer {
    id: lateSettleTimer
    interval: 2500
    onTriggered: root.refresh()
  }

  Timer {
    id: statusTimer
    interval: 2800
    onTriggered: root.actionStatus = ""
  }

  Timer {
    id: watchdog
    interval: 6000
    onTriggered: root.abortProbe()
  }

  Process {
    id: probe
    running: false
    command: []
    stdout: StdioCollector { id: probeOut; waitForEnd: true }
    stderr: StdioCollector { id: probeErr; waitForEnd: true }
    onExited: function (exitCode) {
      root.applyProbe(exitCode, String(probeOut.text || ""), String(probeErr.text || ""))
    }
  }
}
