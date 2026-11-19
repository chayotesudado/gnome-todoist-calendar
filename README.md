# Todoist Calendar (GNOME Shell extension)

Private GNOME Shell extension, for GNOME 51, that puts your Todoist tasks in the clock's date menu in place of calendar events. It talks to the Todoist API directly, so it works with whatever Todoist client you use, Planify included. It sits beside Habits and Claude Usage and works the same way.

- **Calendar dots** mark days with tasks due, not days with events.
- **The events card becomes a checklist** for the selected day. On today it lists overdue tasks first, as Todoist's Today view does. Each row shows the task, then its time (if it has one), its project, and for overdue tasks the date it was due. Subtasks sit indented under their parent. Check-box rings use Todoist's priority colors: red p1, orange p2, blue p3.
- **Ticking a task completes it** in Todoist, and Planify (or any other Todoist client) picks it up on its next sync. Ticked tasks stay in the list, struck through, until the menu closes, so a mis-tick can be unticked. A recurring task can't be unticked here, because Todoist has already moved it to its next date.
- **Every task is listed.** The list has no cap: the date menu grows to the screen height, then its right column scrolls.
- Clicking the card's title ("Today") opens Planify if it's installed, else the Todoist app, else Todoist on the web.

Calendar events from Evolution Data Server no longer show in the date menu while the extension is enabled. Disabling it puts the stock event source back.

- **Data:** the Todoist API (`api.todoist.com/api/v1`), using your personal API token, kept in the login keyring. It doesn't read or write any client's local data. Tasks in Planify-only (local) projects aren't in Todoist, so they don't appear.
- **Install:**
  ```sh
  glib-compile-schemas schemas
  ln -s "$PWD" ~/.local/share/gnome-shell/extensions/todoist-calendar@chayotesudado
  ```
  then log out and back in, `gnome-extensions enable todoist-calendar@chayotesudado`, and add the token in Settings.
- **Settings:** `gnome-extensions prefs todoist-calendar@chayotesudado`
  - API token: from Todoist › Settings › Integrations › Developer
  - Show overdue tasks: default on
  - Refresh interval: default 5 minutes; opening the menu also refreshes, at most every 30 seconds
- **Tests:** `gjs -m tests/tasks.test.js`

## How it hooks in

The extension relies on these GNOME Shell 51 internals (`ui/dateMenu.js`). Check them on each major GNOME release:

- `DateMenuButton._getEventSource()` is overridden on the instance to return a task-backed `Calendar.EventSourceBase`, and `_sessionUpdated()` re-applies it. Disabling deletes the override and calls `_sessionUpdated()` again.
- The source reports `hasCalendars = false`, which keeps the stock `_eventsItem` card hidden. The checklist card is inserted next to it in the displays box and reuses its style classes.
- It listens to the calendar's `selected-date-changed` signal and the menu's `open-state-changed` signal.
