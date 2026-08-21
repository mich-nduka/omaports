import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Omaports: the open dev ports on this machine, from the Omarchy bar.
//
// The widget is a count of what you are running. The panel is the list, and
// its whole trick is naming things properly: `ss` reports a port as a pid and
// a thread name, and the panel reports it as "3000 · Vite" under the heading
// "nexahubtech", because it went and read the command line and the working
// directory itself. From there the actions are the four things anyone
// actually does with a dev port — open it, copy it, open a terminal where it
// lives, or kill it.
//
// Every process lives in Service.qml so the bar icon stays honest with the
// panel closed.
Panel {
  id: root

  moduleName: "io.github.mich-nduka.omaports"
  ipcTarget: "io.github.mich-nduka.omaports"
  manageIpc: false

  property string filter: Model.defaultFilter()
  property string searchQuery: ""
  property var selectedKeys: []
  property string focusSection: "filters"
  property int filterIndex: 0
  property int listIndex: 0
  property bool cursorActive: false
  property bool killForce: false

  readonly property var filterIds: Model.filterIds()
  readonly property var catalog: server.rows
  readonly property var visibleRows: Model.searchBy(Model.filterBy(catalog, filter), searchQuery)
  readonly property var groups: Model.groupItems(visibleRows)

  readonly property var selectedRows: {
    var keys = {}
    var i
    for (i = 0; i < selectedKeys.length; i++) keys[selectedKeys[i]] = true
    var out = []
    for (i = 0; i < catalog.length; i++) {
      if (keys[Model.resourceKey(catalog[i])]) out.push(catalog[i])
    }
    return out
  }
  readonly property int selectedCount: selectedRows.length
  readonly property int selectedVisibleCount: {
    var n = 0
    for (var i = 0; i < visibleRows.length; i++) {
      if (selectedKeys.indexOf(Model.resourceKey(visibleRows[i])) >= 0) n++
    }
    return n
  }
  readonly property bool allVisibleSelected: visibleRows.length > 0 && selectedVisibleCount === visibleRows.length

  // ------------------------------------------------------------- theme

  readonly property bool vertical: bar ? bar.vertical : false
  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color iconColor: server.hasProblem ? urgent : (server.stats.dev > 0 ? foreground : dim)

  readonly property string glyph: "󰒋"

  readonly property real desiredContentHeight: {
    var listHeight = groups.length > 0 ? groupColumn.implicitHeight : emptyLabel.implicitHeight
    return topChrome.implicitHeight
      + Style.space(12)
      + Math.max(Style.space(40), listHeight)
      + Style.space(8)
      + footer.height
  }

  // ------------------------------------------------------------- text

  function barText() {
    var count = Model.barText(server.stats, server.barLabelMode)
    return count === "" ? glyph : glyph + " " + count
  }

  function heroDetail() {
    if (!server.ready) return ""
    return visibleRows.length > 0 ? String(visibleRows.length) : ""
  }

  // The one thing a row's colour has to answer is whether the port is only
  // yours. Everything else is detail the meta line already carries.
  function statusColor(item) {
    if (!item) return dim
    if (item.exposed && item.dev) return urgent
    if (item.dev) return Color.accent
    if (item.exposed) return Qt.darker(urgent, 1.5)
    return dim
  }

  // ------------------------------------------------------------- selection

  function isSelected(item) {
    if (!item) return false
    return selectedKeys.indexOf(Model.resourceKey(item)) >= 0
  }

  function toggleSelected(item) {
    if (!item) return
    var key = Model.resourceKey(item)
    if (!key) return
    var next = []
    var i
    for (i = 0; i < selectedKeys.length; i++) next.push(String(selectedKeys[i]))
    i = next.indexOf(key)
    if (i >= 0) next.splice(i, 1)
    else next.push(key)
    selectedKeys = next
  }

  function groupSelectedCount(group) {
    if (!group || !group.items) return 0
    var n = 0
    for (var i = 0; i < group.items.length; i++) {
      if (isSelected(group.items[i])) n++
    }
    return n
  }

  function toggleGroup(group) {
    if (!group || !group.items) return
    var on = groupSelectedCount(group) < group.items.length
    var map = {}
    var i
    for (i = 0; i < selectedKeys.length; i++) map[selectedKeys[i]] = true
    for (i = 0; i < group.items.length; i++) {
      var key = Model.resourceKey(group.items[i])
      if (on) map[key] = true
      else delete map[key]
    }
    selectedKeys = Object.keys(map)
  }

  function toggleSelectAllVisible() {
    var allOn = allVisibleSelected
    var map = {}
    var i
    for (i = 0; i < selectedKeys.length; i++) map[selectedKeys[i]] = true
    for (i = 0; i < visibleRows.length; i++) {
      var key = Model.resourceKey(visibleRows[i])
      if (allOn) delete map[key]
      else map[key] = true
    }
    selectedKeys = Object.keys(map)
  }

  // With nothing ticked, an action still has an obvious target: the row the
  // cursor is on.
  function actionTargets() {
    if (selectedCount > 0) return selectedRows
    var one = currentRow()
    return one ? [one] : []
  }

  function currentRow() {
    if (visibleRows.length === 0) return null
    return visibleRows[Math.max(0, Math.min(listIndex, visibleRows.length - 1))]
  }

  readonly property var killTargets: {
    var targets = actionTargets()
    var out = []
    for (var i = 0; i < targets.length; i++) {
      if (Model.killable(targets[i], server.selfUid)) out.push(targets[i])
    }
    return out
  }
  readonly property bool canOpen: {
    var targets = actionTargets()
    for (var i = 0; i < targets.length; i++) if (targets[i].http) return true
    return false
  }
  readonly property bool canTerminal: {
    var targets = actionTargets()
    for (var i = 0; i < targets.length; i++) if (targets[i].cwd) return true
    return false
  }

  // ------------------------------------------------------------- actions

  // Six tabs is a mistake nobody meant to make, so a large selection opens
  // the first few and says so rather than obeying literally.
  function openSelection() {
    var targets = actionTargets()
    var opened = 0
    for (var i = 0; i < targets.length && opened < 4; i++) {
      if (!targets[i].http || !targets[i].url) continue
      server.openUrl(targets[i].url)
      opened++
    }
    if (opened > 0) root.close()
  }

  function copySelection() {
    var targets = actionTargets()
    if (!targets.length) return
    var lines = []
    for (var i = 0; i < targets.length; i++) {
      var text = Model.copyText(targets[i])
      if (text) lines.push(text)
    }
    server.copyToClipboard(lines.join("\n"))
  }

  function terminalSelection() {
    var targets = actionTargets()
    var opened = 0
    for (var i = 0; i < targets.length && opened < 3; i++) {
      if (!targets[i].cwd) continue
      server.openTerminal(targets[i].cwd)
      opened++
    }
    if (opened > 0) root.close()
  }

  function requestKill(force) {
    if (killTargets.length === 0) return
    killForce = force === true
    if (!server.confirmKill) {
      commitKill()
      return
    }
    killConfirm.selectedIndex = 1
    killConfirm.opened = true
  }

  function commitKill() {
    server.killRows(killTargets, killForce)
    selectedKeys = []
    killConfirm.opened = false
  }

  // ------------------------------------------------------------- cursor

  function ensureCursor() {
    if (filterIndex < 0) filterIndex = 0
    if (filterIndex > filterIds.length - 1) filterIndex = filterIds.length - 1
    if (visibleRows.length === 0) {
      if (focusSection === "list") focusSection = "search"
      listIndex = 0
      return
    }
    if (listIndex >= visibleRows.length) listIndex = visibleRows.length - 1
    if (listIndex < 0) listIndex = 0
  }

  function moveCursor(dx, dy) {
    cursorActive = true
    ensureCursor()
    if (focusSection === "filters") {
      if (dx !== 0) {
        filterIndex = Math.max(0, Math.min(filterIds.length - 1, filterIndex + dx))
        return
      }
      if (dy > 0) root.focusSearch()
      return
    }
    if (focusSection === "search") {
      if (dy < 0) focusSection = "filters"
      else if (dy > 0 && visibleRows.length > 0) {
        focusSection = "list"
        listIndex = 0
      }
      return
    }
    if (focusSection === "list") {
      if (dy < 0 && listIndex === 0) {
        root.focusSearch()
        return
      }
      listIndex = Math.max(0, Math.min(visibleRows.length - 1, listIndex + dy))
    }
  }

  function activateCursor() {
    ensureCursor()
    if (focusSection === "filters") { setFilter(filterIds[filterIndex]); return }
    if (focusSection === "search") { root.focusSearch(); return }
    var item = currentRow()
    if (item) root.toggleSelected(item)
  }

  function setFilter(next) {
    if (filterIds.indexOf(next) < 0) return
    filter = next
    filterIndex = filterIds.indexOf(next)
    listIndex = 0
    if (listFlick) listFlick.contentY = 0
  }

  function setFilterCursor(index) {
    cursorActive = true
    focusSection = "filters"
    filterIndex = index
  }

  function setListCursor(index) {
    cursorActive = true
    focusSection = "list"
    listIndex = index
  }

  function setSearchCursor() {
    cursorActive = true
    focusSection = "search"
  }

  function focusSearch() {
    setSearchCursor()
    if (searchField) searchField.forceActiveFocus()
  }

  function blurSearch() {
    if (keyCatcher) keyCatcher.forceActiveFocus()
  }

  function scrollItemIntoView(item) {
    if (!listFlick || !item) return
    Qt.callLater(function () {
      if (!item) return
      var margin = Style.space(6)
      var point = item.mapToItem(listFlick.contentItem, 0, 0)
      var top = point.y
      var bottom = top + item.height
      var viewTop = listFlick.contentY
      var viewBottom = viewTop + listFlick.height
      var maxY = Math.max(0, listFlick.contentHeight - listFlick.height)
      if (top < viewTop + margin) listFlick.contentY = Math.max(0, top - margin)
      else if (bottom > viewBottom - margin) listFlick.contentY = Math.min(maxY, bottom + margin - listFlick.height)
    })
  }

  function indexOfRow(item) {
    if (!item) return -1
    var key = Model.resourceKey(item)
    if (!key) return -1
    for (var i = 0; i < visibleRows.length; i++) {
      if (Model.resourceKey(visibleRows[i]) === key) return i
    }
    return -1
  }

  // ------------------------------------------------------------- lifecycle

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onOpenedChanged: if (opened) {
    cursorActive = false
    searchQuery = ""
    selectedKeys = []
    killConfirm.opened = false
    if (searchField) searchField.text = ""
    if (listFlick) listFlick.contentY = 0
    server.refresh()
    Qt.callLater(function () { keyCatcher.forceActiveFocus() })
  }

  onVisibleRowsChanged: ensureCursor()

  Service {
    id: server
    settings: root.settings
    panelOpen: root.opened
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { server.refresh(); return "ok" }
    function count(): string { return String(server.stats.dev) + "/" + String(server.stats.total) }
    function list(): string {
      var out = []
      for (var i = 0; i < server.rows.length; i++) {
        var row = server.rows[i]
        out.push({
          port: row.port,
          proto: row.proto,
          name: Model.displayName(row),
          project: row.project,
          pid: row.pid,
          scope: row.scope,
          dev: row.dev,
          url: row.url
        })
      }
      return JSON.stringify(out)
    }
  }

  // ------------------------------------------------------------- bar entry

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.barText()
    fontSize: Style.font.body
    foreground: root.iconColor
    active: server.hasProblem
    tooltipText: Model.tooltip(server.stats, server.ready)
      + (server.lastError !== "" ? "\n" + server.lastError : "")

    onPressed: function (b) {
      if (b === Qt.RightButton) server.refresh()
      else root.toggle()
    }
  }

  // ------------------------------------------------------------- panel

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(430))
    // Sized to the list rather than to a fixed tall card: four dev ports
    // should not open a panel with half a screen of nothing under them. The
    // cap is what a long "all" list runs into, and the Flickable takes over
    // from there.
    contentHeight: panel.fittedContentHeight(root.desiredContentHeight, Style.space(720))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      blocked: searchField.activeFocus

      onMoveRequested: function (dx, dy) {
        if (killConfirm.opened) {
          killConfirm.selectedIndex = killConfirm.selectedIndex === 0 ? 1 : 0
          return
        }
        if (!root.cursorActive) { root.cursorActive = true; return }
        root.moveCursor(dx, dy)
      }
      onActivateRequested: {
        if (killConfirm.opened) {
          if (killConfirm.selectedIndex === 1) root.commitKill()
          else killConfirm.opened = false
          return
        }
        if (root.cursorActive) root.activateCursor()
      }
      onCloseRequested: {
        if (killConfirm.opened) { killConfirm.opened = false; return }
        root.close()
      }
      onTabRequested: function (direction) { root.switchPanel(direction) }
      // The catcher's own destructive key, which is `x`. Kill is what
      // "delete" means for a port.
      onDeleteRequested: {
        if (killConfirm.opened) return
        root.requestKill(false)
      }
      onTextKey: function (text) {
        if (killConfirm.opened) return
        var key = text.toLowerCase()

        if (key === "r") server.refresh()
        else if (key === "/") root.focusSearch()
        else if (key === "v") root.toggleSelectAllVisible()
        else if (key === "o") root.openSelection()
        else if (key === "y") root.copySelection()
        else if (key === "t") root.terminalSelection()
        // Plain "k" never arrives — PanelKeyCatcher takes hjkl for the
        // cursor before this runs. Only the shifted one gets here, which is
        // why force kill is the one that lives on a letter.
        else if (key === "k") root.requestKill(true)
        else if (key === "1") root.setFilter(root.filterIds[0])
        else if (key === "2") root.setFilter(root.filterIds[1])
        else if (key === "3") root.setFilter(root.filterIds[2])
        else if (key === "4") root.setFilter(root.filterIds[3])
      }

      Column {
        id: topChrome
        width: parent.width
        spacing: Style.space(12)

        PanelHero {
          id: hero
          width: parent.width
          title: Model.title(server.stats)
          meta: Model.heroMeta(server.stats, server.ready)
          detail: root.heroDetail()
          foreground: server.hasProblem ? root.urgent : root.foreground
          fontFamily: root.fontFamily
          iconOpacity: server.ready ? 1.0 : 0.5
          iconComponent: Component {
            Text {
              text: root.glyph
              textFormat: Text.PlainText
              color: root.iconColor
              font.family: root.fontFamily
              font.pixelSize: Style.font.display
            }
          }

          MouseArea {
            anchors.fill: parent
            onClicked: server.refresh()
          }
        }

        Text {
          visible: server.actionStatus !== "" || server.lastError !== ""
          width: parent.width
          text: server.actionStatus !== "" ? server.actionStatus : server.lastError
          textFormat: Text.PlainText
          color: server.lastError !== "" && server.actionStatus === "" ? root.urgent : root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.WordWrap
        }

        // ---- filter chips ---------------------------------------------------

        Row {
          id: filterRow
          width: parent.width
          spacing: Style.space(6)
          readonly property real cellWidth: (width - spacing * (root.filterIds.length - 1)) / root.filterIds.length

          Repeater {
            model: root.filterIds

            Button {
              required property string modelData
              required property int index
              width: filterRow.cellWidth
              text: Model.filterLabel(modelData)
              fontSize: Style.font.caption
              foreground: modelData === "exposed" && server.stats.exposed > 0 ? root.urgent : root.foreground
              fontFamily: root.fontFamily
              bordered: true
              active: root.filter === modelData
              hasCursor: root.cursorActive && root.focusSection === "filters" && root.filterIndex === index
              onClicked: root.setFilter(modelData)
              onHovered: function (h) { if (h) root.setFilterCursor(index) }
            }
          }
        }

        TextField {
          id: searchField
          width: parent.width
          foreground: root.foreground
          font.pixelSize: Style.font.bodySmall
          verticalPadding: Style.space(4)
          placeholderText: Model.searchPlaceholder()
          text: root.searchQuery
          hasCursor: root.cursorActive && root.focusSection === "search" && !activeFocus
          onTextChanged: {
            root.searchQuery = text
            root.listIndex = 0
            if (listFlick) listFlick.contentY = 0
          }
          onHoveredChanged: if (hovered) root.setSearchCursor()
          onActiveFocusChanged: if (activeFocus) root.setSearchCursor()
          Keys.onPressed: function (event) {
            if (event.key === Qt.Key_Down) {
              root.blurSearch()
              root.cursorActive = true
              if (root.visibleRows.length > 0) {
                root.focusSection = "list"
                root.listIndex = 0
              } else {
                root.focusSection = "filters"
              }
              event.accepted = true
              return
            }
            if (event.key === Qt.Key_Up) {
              root.blurSearch()
              root.cursorActive = true
              root.focusSection = "filters"
              event.accepted = true
              return
            }
            if (event.key === Qt.Key_Escape) {
              if (root.searchQuery !== "") {
                root.searchQuery = ""
                text = ""
              } else {
                root.blurSearch()
                root.cursorActive = true
                root.focusSection = "filters"
              }
              event.accepted = true
            }
          }
        }

        // ---- command bar ----------------------------------------------------

        RowLayout {
          id: commandBar
          visible: root.visibleRows.length > 0
          width: parent.width
          spacing: Style.space(4)

          Text {
            Layout.fillWidth: true
            text: root.selectedCount > 0
              ? (root.selectedCount === 1 ? "1 selected" : root.selectedCount + " selected")
              : Model.formatCount(root.visibleRows.length, "port", "ports")
            textFormat: Text.PlainText
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }

          PanelActionButton {
            iconText: "󰖟"
            tooltipText: "Open in the browser"
            foreground: root.foreground
            fontFamily: root.fontFamily
            enabled: root.canOpen
            onClicked: root.openSelection()
          }

          PanelActionButton {
            iconText: "󰆏"
            tooltipText: "Copy the address"
            foreground: root.foreground
            fontFamily: root.fontFamily
            enabled: root.visibleRows.length > 0
            onClicked: root.copySelection()
          }

          PanelActionButton {
            iconText: "󰆍"
            tooltipText: "Open a terminal where this server runs"
            foreground: root.foreground
            fontFamily: root.fontFamily
            enabled: root.canTerminal
            onClicked: root.terminalSelection()
          }

          PanelActionButton {
            iconText: "󰅖"
            tooltipText: "Free the port — SIG" + server.killSignal
            foreground: root.foreground
            hoverColor: root.urgent
            fontFamily: root.fontFamily
            enabled: root.killTargets.length > 0
            onClicked: root.requestKill(false)
          }

          PanelActionButton {
            iconText: "󰚌"
            tooltipText: "Force kill — SIGKILL"
            foreground: root.foreground
            hoverColor: root.urgent
            fontFamily: root.fontFamily
            enabled: root.killTargets.length > 0
            onClicked: root.requestKill(true)
          }
        }
      }

      // ---- the list ---------------------------------------------------------

      Item {
        id: listArea
        anchors.top: topChrome.bottom
        anchors.bottom: footer.top
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.topMargin: Style.space(12)
        anchors.bottomMargin: Style.space(8)

        Text {
          id: emptyLabel
          textFormat: Text.PlainText
          visible: root.visibleRows.length === 0
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.top: parent.top
          text: !server.installed
            ? "`ss` is not on PATH. Install iproute2 and the panel fills in."
            : (!server.reachable && server.ready
              ? "The socket table could not be read."
              : (String(root.searchQuery).trim() !== "" ? Model.noMatchText() : Model.emptyText(root.filter)))
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          wrapMode: Text.WordWrap
          horizontalAlignment: Text.AlignHCenter
        }

        Flickable {
          id: listFlick
          anchors.fill: parent
          visible: root.groups.length > 0
          contentWidth: width
          contentHeight: groupColumn.implicitHeight
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          flickableDirection: Flickable.VerticalFlick
          interactive: contentHeight > height
          ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

          Column {
            id: groupColumn
            width: listFlick.width
            spacing: Style.space(10)

            Repeater {
              model: root.groups

              Column {
                required property var modelData
                width: groupColumn.width
                spacing: Style.space(4)

                Row {
                  width: groupColumn.width
                  spacing: Style.space(6)

                  SelectionBox {
                    anchors.verticalCenter: parent.verticalCenter
                    checked: root.groupSelectedCount(modelData) === (modelData.items || []).length
                      && (modelData.items || []).length > 0
                    partial: {
                      var n = root.groupSelectedCount(modelData)
                      return n > 0 && n < (modelData.items || []).length
                    }
                    onClicked: root.toggleGroup(modelData)
                  }

                  PanelSectionHeader {
                    width: parent.width - Style.space(22)
                    text: String(modelData.name).toUpperCase()
                      + "  " + modelData.total
                      + (modelData.exposed > 0 ? "  ·  " + modelData.exposed + " exposed" : "")
                    foreground: modelData.exposed > 0 && modelData.dev > 0 ? root.urgent : root.foreground
                    fontFamily: root.fontFamily
                    textFormat: Text.PlainText

                    TapHandler {
                      gesturePolicy: TapHandler.ReleaseWithinBounds
                      onTapped: root.toggleGroup(modelData)
                    }
                    HoverHandler { cursorShape: Qt.PointingHandCursor }
                  }
                }

                Repeater {
                  model: modelData.items

                  PortRow {
                    required property var modelData
                    width: groupColumn.width
                    item: modelData
                    rowIndex: root.indexOfRow(modelData)
                  }
                }
              }
            }
          }
        }
      }

      // ---- footer -----------------------------------------------------------

      Item {
        id: footer
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        height: toolRow.implicitHeight

        Text {
          anchors.left: parent.left
          anchors.right: toolRow.left
          anchors.rightMargin: Style.space(8)
          anchors.verticalCenter: parent.verticalCenter
          text: server.stats.total + " listening · " + server.stats.mine + " yours"
            + (server.includeUdp ? " · tcp+udp" : "")
          textFormat: Text.PlainText
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }

        Row {
          id: toolRow
          anchors.right: parent.right
          spacing: Style.space(2)

          Button {
            iconText: "󰑐"
            tooltipText: "Refresh"
            iconSize: Style.font.body
            foreground: server.refreshing ? Color.accent : root.foreground
            fontFamily: root.fontFamily
            horizontalPadding: Style.space(9)
            bordered: false
            onClicked: server.refresh()
          }
        }
      }

      ConfirmDialog {
        id: killConfirm
        anchors.fill: parent
        z: 10
        message: Model.killMessage(root.killTargets)
          + (root.killForce ? " SIGKILL gives it no chance to save anything." : "")
        confirmText: root.killForce ? "Force kill" : "Kill"
        background: Color.popups.background
        foreground: root.foreground
        fontFamily: root.fontFamily
        onCanceled: killConfirm.opened = false
        onConfirmed: root.commitKill()
      }
    }
  }

  // ------------------------------------------------------------- components

  component SelectionBox: Item {
    property bool checked: false
    property bool partial: false
    property bool interactive: true
    signal clicked()

    implicitWidth: Style.space(16)
    implicitHeight: Style.space(16)

    Rectangle {
      anchors.centerIn: parent
      width: Style.space(14)
      height: Style.space(14)
      radius: Style.space(3)
      color: parent.checked ? Color.accent : "transparent"
      border.width: Math.max(1, Style.space(1))
      border.color: parent.checked || parent.partial ? Color.accent : root.dim

      Rectangle {
        visible: parent.parent.partial && !parent.parent.checked
        anchors.centerIn: parent
        width: parent.width - Style.space(6)
        height: Math.max(2, Style.space(2))
        color: Color.accent
      }
    }

    TapHandler {
      enabled: parent.interactive
      gesturePolicy: TapHandler.ReleaseWithinBounds
      onTapped: parent.clicked()
    }
    HoverHandler {
      enabled: parent.interactive
      cursorShape: Qt.PointingHandCursor
    }
  }

  component PortRow: CursorSurface {
    id: row
    property var item: null
    property int rowIndex: -1
    readonly property bool pending: !!(item && server.pendingKeys[Model.resourceKey(item)])
    readonly property bool checked: root.isSelected(item)

    hasCursor: root.cursorActive && root.focusSection === "list" && root.listIndex === rowIndex && rowIndex >= 0
    current: row.checked
    foreground: root.foreground
    opacity: row.pending ? 0.55 : 1.0

    implicitHeight: rowContent.implicitHeight + Style.spacing.rowPaddingX
    onHasCursorChanged: if (hasCursor) root.scrollItemIntoView(row)

    HoverHandler {
      cursorShape: Qt.PointingHandCursor
      onHoveredChanged: if (hovered && row.rowIndex >= 0) root.setListCursor(row.rowIndex)
    }

    TapHandler {
      acceptedButtons: Qt.LeftButton
      gesturePolicy: TapHandler.ReleaseWithinBounds
      onTapped: root.toggleSelected(row.item)
    }

    RowLayout {
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(6)
      anchors.rightMargin: Style.space(6)
      spacing: Style.space(8)

      SelectionBox {
        Layout.alignment: Qt.AlignVCenter
        checked: row.checked
        interactive: false
      }

      Rectangle {
        width: Style.space(8)
        height: Style.space(8)
        radius: width / 2
        color: root.statusColor(row.item)
        Layout.alignment: Qt.AlignVCenter
      }

      ColumnLayout {
        id: rowContent
        Layout.fillWidth: true
        spacing: Style.space(1)

        Text {
          Layout.fillWidth: true
          text: Model.primaryLabel(row.item)
          textFormat: Text.PlainText
          color: row.item && row.item.exposed && row.item.dev ? root.urgent : root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          elide: Text.ElideRight
        }

        Text {
          Layout.fillWidth: true
          text: Model.metaLine(row.item, server.home)
          textFormat: Text.PlainText
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
      }
    }
  }
}
