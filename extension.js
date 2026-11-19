import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Calendar from 'resource:///org/gnome/shell/ui/calendar.js';
import {CheckBox} from 'resource:///org/gnome/shell/ui/checkBox.js';
import {formatDateWithCFormatString, formatTime} from 'resource:///org/gnome/shell/misc/dateUtils.js';

import * as Tasks from './lib/tasks.js';
import * as Token from './lib/token.js';

// Todoist tasks in the clock's date menu, in place of calendar events.
//
// - The calendar's dots mark days with tasks due, instead of days with events.
//   This swaps the date menu's event source (normally Evolution Data Server)
//   for one backed by the tasks.
// - The events card becomes a checklist for the selected day. On today it
//   lists overdue tasks too, as Todoist's Today view does. Ticking a task
//   completes it in Todoist; any Todoist client (Planify, the Todoist app, the
//   web) picks it up on its next sync. The card shows every task: the date
//   menu grows to fit the selected day's list, up to the screen height, then
//   its column scrolls.
//
// Everything goes through the Todoist API with the user's API token. No
// client's local data is read or written.

// Clicking the card's title opens the first of these that is installed, else
// Todoist on the web.
const TODOIST_APPS = ['io.github.alainm23.planify.desktop', 'com.todoist.Todoist.desktop'];
const TODOIST_WEB = 'https://app.todoist.com/app/today';
const MIN_FETCH_GAP_MS = 30 * 1000;
const VERTICAL = {orientation: Clutter.Orientation.VERTICAL};

const ERRORS = {
    'no-token': () => _('Add your Todoist API token in Settings'),
    'unauthorized': () => _('Todoist didn’t accept the API token'),
    'keyring': () => _('Couldn’t read the API token from the keyring'),
    'rate-limited': () => _('Too many requests, retrying later'),
    'unavailable': () => _('Couldn’t reach Todoist'),
};
// Errors fixed in Settings; their message opens it.
const SETTINGS_ERRORS = new Set(['no-token', 'unauthorized']);

function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function fromDayKey(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
}

// "Today", "Yesterday", "Tomorrow", else "November 24" (with the year if
// another year), as the stock events card titles itself.
function dayTitle(date) {
    const day = startOfDay(date);
    const today = startOfDay(new Date());
    const diff = Math.round((day - today) / 86400000);
    if (diff === 0)
        return _('Today');
    if (diff === -1)
        return _('Yesterday');
    if (diff === 1)
        return _('Tomorrow');
    return formatDateWithCFormatString(day,
        day.getFullYear() === today.getFullYear() ? '%B %-d' : '%B %-d %Y');
}

// ---- event source: tasks as the calendar's "events"
const TaskEventSource = GObject.registerClass({
    GTypeName: 'TodoistCalendarEventSource',
}, class TaskEventSource extends Calendar.EventSourceBase {
    _init() {
        super._init();
        this._tasks = [];
        this._days = new Set();
    }

    get isLoading() {
        return false;
    }

    // False keeps the stock events card hidden: it shows itself only when
    // its event source has calendars. Our own card replaces it.
    get hasCalendars() {
        return false;
    }

    // The date menu destroys its outgoing source whenever it swaps sources,
    // including when it re-applies this one. The extension owns its lifetime.
    destroy() {
    }

    requestRange(_begin, _end) {
    }

    getEvents(begin, end) {
        if (!begin || !end)
            return [];
        return this._tasks
            .map(t => ({t, start: t.time ?? fromDayKey(t.day)}))
            .filter(({start}) => start >= begin && start < end)
            .map(({t, start}) => ({
                id: t.id,
                date: start,
                end: t.time ? start : new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1),
                summary: t.content,
            }));
    }

    hasEvents(day) {
        return this._days.has(Tasks.dayKey(day));
    }

    setTasks(tasks) {
        this._tasks = tasks;
        this._days = Tasks.dueDays(tasks);
        this.emit('changed');
    }
});

// ---- Todoist API
class TodoistClient {
    constructor() {
        this._session = new Soup.Session({user_agent: 'gnome-todoist-calendar', timeout: 20});
        this.cancellable = new Gio.Cancellable();
    }

    destroy() {
        this.cancellable.cancel();
        this._session.abort();
    }

    _send(method, path, token) {
        const msg = Soup.Message.new(method, `${Tasks.API}${path}`);
        msg.request_headers.append('Authorization', `Bearer ${token}`);
        return new Promise((resolve, reject) => {
            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this.cancellable, (session, res) => {
                let bytes;
                try {
                    bytes = session.send_and_read_finish(res);
                } catch (e) {
                    e.kind = e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) ? 'cancelled' : 'unavailable';
                    reject(e);
                    return;
                }
                const status = msg.get_status();
                if (status < 200 || status >= 300) {
                    const e = new Error(`Todoist ${method} ${path.split('?')[0]}: HTTP ${status}`);
                    e.kind = Tasks.errorKind(status);
                    reject(e);
                    return;
                }
                resolve(new TextDecoder().decode(bytes.get_data() ?? new Uint8Array()));
            });
        });
    }

    async _all(path, token) {
        const out = [];
        let cursor = null;
        for (let page = 0; page < 50; page++) {
            const q = `${path}?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
            const {results, next} = Tasks.parsePage(await this._send('GET', q, token));
            out.push(...results);
            cursor = next;
            if (!cursor)
                break;
        }
        return out;
    }

    async fetch(token) {
        const [tasks, projects] = await Promise.all([
            this._all('/tasks', token),
            this._all('/projects', token),
        ]);
        return {
            tasks: tasks.map(Tasks.fromApi).filter(Boolean),
            projects: new Map(projects.map(p => [String(p.id), String(p.name ?? '')])),
        };
    }

    close(id, token) {
        return this._send('POST', `/tasks/${encodeURIComponent(id)}/close`, token);
    }

    reopen(id, token) {
        return this._send('POST', `/tasks/${encodeURIComponent(id)}/reopen`, token);
    }
}

// ---- the checklist card
const TaskSection = GObject.registerClass({
    GTypeName: 'TodoistCalendarSection',
}, class TaskSection extends St.BoxLayout {
    _init(ext) {
        // The stock card's classes, so it looks like the events card it
        // replaces; a box, not a button, so the check boxes take the clicks.
        super._init({...VERTICAL, style_class: 'events-button todoist-calendar', x_expand: true});
        this._ext = ext;
        this._date = startOfDay(new Date());
        // Tasks ticked or unticked while the menu is open: id → {task, closed,
        // busy}. They stay in the list, checked, until the menu closes, so a
        // mis-tick can be undone.
        this._done = new Map();

        const box = new St.BoxLayout({...VERTICAL, style_class: 'events-box', x_expand: true});
        this.add_child(box);

        this._title = new St.Button({
            style_class: 'events-title todoist-calendar-title',
            x_align: Clutter.ActorAlign.START,
            can_focus: true,
            accessible_name: _('Open Todoist'),
        });
        this._title.connect('clicked', () => ext.openTodoist());
        box.add_child(this._title);

        this._list = new St.BoxLayout({...VERTICAL, style_class: 'events-list todoist-calendar-list', x_expand: true});
        box.add_child(this._list);
    }

    setDate(date) {
        this._date = startOfDay(date);
        this.render();
    }

    // Forget this menu session's ticks. Returns whether there were any, so
    // the extension knows to refresh.
    clearDone() {
        const had = this._done.size > 0;
        this._done.clear();
        return had;
    }

    render() {
        this._list.destroy_all_children();
        this._title.label = dayTitle(this._date);

        const {tasks, loaded, error} = this._ext.state;
        if (!loaded) {
            this._list.add_child(this._statusRow(error ?? 'loading'));
            return;
        }

        // Ticked tasks show as they were when ticked, even once Todoist has
        // dropped them or moved a recurring one to its next date.
        const byId = new Map(tasks.map(t => [t.id, t]));
        for (const [id, d] of this._done) {
            if (d.closed || !byId.has(id))
                byId.set(id, d.task);
        }

        const today = Tasks.dayKey(new Date());
        const day = Tasks.dayKey(this._date);
        const groups = Tasks.groupsFor([...byId.values()], day, today,
            {showOverdue: this._ext.settings.get_boolean('show-overdue')});
        const labelled = groups.length > 1;

        for (const g of groups) {
            if (labelled) {
                // Secondary text at the opacity GNOME uses for its own.
                this._list.add_child(new St.Label({
                    text: g.kind === 'overdue' ? _('Overdue') : dayTitle(this._date),
                    style_class: 'todoist-calendar-group',
                    opacity: 178,
                }));
            }
            for (const item of g.items)
                this._list.add_child(this._row(item, g.kind === 'overdue'));
        }

        if (groups.every(g => g.items.length === 0)) {
            this._list.add_child(new St.Label({
                text: day === today ? _('Nothing due today') : _('Nothing due'),
                style_class: 'event-placeholder',
            }));
        }
        if (error)
            this._list.add_child(this._statusRow(error));
    }

    _statusRow(kind) {
        const text = kind === 'loading' ? _('Loading…') : (ERRORS[kind] ?? ERRORS.unavailable)();
        const label = new St.Label({text, x_expand: true});
        label.clutter_text.line_wrap = true;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        if (!SETTINGS_ERRORS.has(kind)) {
            label.style_class = 'event-placeholder todoist-calendar-status';
            return label;
        }
        const button = new St.Button({
            child: label,
            style_class: 'event-placeholder todoist-calendar-status todoist-calendar-link',
            x_expand: true,
            can_focus: true,
        });
        button.connect('clicked', () => this._ext.openSettings());
        return button;
    }

    _caption(task, overdue) {
        const parts = [];
        if (overdue)
            parts.push(formatDateWithCFormatString(fromDayKey(task.day), '%b %-d'));
        if (task.time)
            parts.push(formatTime(task.time, {timeOnly: true}).trim());
        const project = task.projectId ? this._ext.state.projects.get(task.projectId) : null;
        if (project)
            parts.push(project);
        return parts.join(' · ');
    }

    _markup(task, overdue, checked) {
        let text = Tasks.escapeMarkup(task.content || _('Untitled task'));
        if (checked)
            text = `<s>${text}</s>`;
        const caption = this._caption(task, overdue);
        if (caption)
            text += `\n<span size="small" alpha="55%">${Tasks.escapeMarkup(caption)}</span>`;
        return checked ? `<span alpha="55%">${text}</span>` : text;
    }

    _row({task, depth}, overdue) {
        const d = this._done.get(task.id);
        const checked = Boolean(d?.closed);
        const cb = new CheckBox('');
        cb.x_expand = true;
        // CheckBox's inner box expands vertically, which would make the row
        // soak up spare height whenever the card is taller than its list.
        cb.y_expand = false;
        cb.add_style_class_name(`todoist-p${5 - Math.min(4, Math.max(1, task.priority))}`);
        if (depth)
            cb.style = `margin-left: ${depth * 1.6}em;`;
        cb.checked = checked;
        // A completed recurring task has moved on to its next date; reopening
        // wouldn't move it back, so it can't be unticked from here.
        cb.reactive = !d?.busy && !(checked && task.recurring);
        cb.getLabelActor().clutter_text.set_markup(this._markup(task, overdue, checked));
        cb.connect('clicked', () => this._toggle(task, overdue, cb));
        return cb;
    }

    async _toggle(task, overdue, cb) {
        const close = cb.checked;
        const entry = {task, closed: close, busy: true};
        this._done.set(task.id, entry);
        cb.reactive = false;
        cb.getLabelActor().clutter_text.set_markup(this._markup(task, overdue, close));

        try {
            await this._ext.setCompleted(task.id, close);
            entry.busy = false;
        } catch (e) {
            if (e.kind === 'cancelled')
                return;
            this._ext.reportError(e);
            if (close)
                this._done.delete(task.id);
            else
                Object.assign(entry, {closed: true, busy: false});
        }
        this.render();
    }
});

export default class TodoistCalendarExtension extends Extension {
    enable() {
        this.settings = this.getSettings();
        this.state = {tasks: [], projects: new Map(), loaded: false, error: null};
        this._lastFetch = 0;
        this._client = new TodoistClient();
        this._source = new TaskEventSource();

        const dm = Main.panel.statusArea.dateMenu;
        this._dateMenu = dm;

        this._section = new TaskSection(this);
        dm._eventsItem.get_parent().insert_child_below(this._section, dm._eventsItem);

        // While a day other than today is selected, the date menu freezes its
        // size at today's (FreezableBinLayout), so a longer list for that day
        // would be cut off and scroll. Unfreeze it so the menu fits the list.
        // The menu hangs from the panel, so it only grows downward: the
        // calendar doesn't move under the pointer.
        this._menuLayout = dm._calendar.get_parent()?.get_parent()?.get_parent()?.layout_manager ?? null;
        if (this._menuLayout && !('frozen' in this._menuLayout))
            this._menuLayout = null;

        // Our own day dots, set higher in the cell than the theme's so they
        // clear the selected day's focus ring (see stylesheet.css).
        dm._calendar.add_style_class_name('todoist-calendar-dots');
        this._syncStyleVariant();

        // The date menu takes its event source from _getEventSource() each
        // time the session mode changes; answer with ours until disabled.
        dm._getEventSource = () => this._source;
        dm._sessionUpdated();

        this._signals = [
            // Runs after the date menu's own handler, which sets the freeze.
            [dm._calendar, dm._calendar.connect('selected-date-changed', (_c, datetime) => {
                if (this._menuLayout)
                    this._menuLayout.frozen = false;
                this._section.setDate(new Date(datetime.to_unix() * 1000));
            })],
            [St.Settings.get(), St.Settings.get().connect('notify::color-scheme', () => this._syncStyleVariant())],
            [Main.sessionMode, Main.sessionMode.connect('updated', () => this._syncStyleVariant())],
            [dm.menu, dm.menu.connect('open-state-changed', (_m, open) => this._onMenu(open))],
            [this.settings, this.settings.connect('changed::refresh-minutes', () => this._schedule())],
            [this.settings, this.settings.connect('changed::show-overdue', () => this._section.render())],
            // Preferences bumps this after saving or removing the token.
            [this.settings, this.settings.connect('changed::token-serial', () => this.refresh(true))],
        ];

        this._section.setDate(new Date());
        this._schedule();
        this.refresh(true);
    }

    disable() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        for (const [obj, id] of this._signals)
            obj.disconnect(id);
        this._signals = [];
        this._client.destroy();
        this._client = null;

        this._dateMenu._calendar.remove_style_class_name('todoist-calendar-dots');
        this._dateMenu._calendar.remove_style_class_name('todoist-calendar-light');
        this._menuLayout = null;

        // Back to the stock Evolution Data Server source.
        delete this._dateMenu._getEventSource;
        this._dateMenu._sessionUpdated();
        this._source = null;

        this._section.destroy();
        this._section = null;
        this._dateMenu = null;
        this.settings = null;
        this.state = null;
    }

    // The theme draws light dots in dark mode and dark ones in light mode.
    _syncStyleVariant() {
        const calendar = this._dateMenu._calendar;
        if (Main.getStyleVariant() === 'light')
            calendar.add_style_class_name('todoist-calendar-light');
        else
            calendar.remove_style_class_name('todoist-calendar-light');
    }

    _schedule() {
        if (this._timer)
            GLib.source_remove(this._timer);
        const seconds = Math.max(1, this.settings.get_uint('refresh-minutes')) * 60;
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            // Not while the menu is open: the list would jump under the pointer.
            if (!this._dateMenu.menu.isOpen)
                this.refresh(true);
            return GLib.SOURCE_CONTINUE;
        });
    }

    _onMenu(open) {
        if (open) {
            this._section.setDate(new Date());
            this.refresh();
        } else if (this._section.clearDone()) {
            this.refresh(true);
        } else {
            this._section.render();
        }
    }

    async _token() {
        let token;
        try {
            token = await Token.lookup(this._client.cancellable);
        } catch (e) {
            e.kind = e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) ? 'cancelled' : 'keyring';
            throw e;
        }
        if (!token) {
            const e = new Error('No Todoist API token in the keyring');
            e.kind = 'no-token';
            throw e;
        }
        return token;
    }

    async refresh(force = false) {
        if (this._inFlight || (!force && Date.now() - this._lastFetch < MIN_FETCH_GAP_MS))
            return;
        this._inFlight = true;
        const client = this._client;
        try {
            const {tasks, projects} = await client.fetch(await this._token());
            if (client !== this._client)
                return; // disabled meanwhile
            Object.assign(this.state, {tasks, projects, loaded: true, error: null});
        } catch (e) {
            if (e.kind === 'cancelled' || client !== this._client)
                return;
            this.reportError(e);
            if (e.kind === 'no-token' || e.kind === 'unauthorized')
                Object.assign(this.state, {tasks: [], loaded: false});
        } finally {
            this._inFlight = false;
            this._lastFetch = Date.now();
        }
        this._source.setTasks(this.state.tasks);
        this._section.render();
    }

    async setCompleted(id, done) {
        const token = await this._token();
        if (done)
            await this._client.close(id, token);
        else
            await this._client.reopen(id, token);
    }

    reportError(e) {
        this.state.error = e.kind ?? 'unavailable';
        if (!e.kind || e.kind === 'unavailable')
            console.warn(`Todoist Calendar: ${e.message}`);
    }

    openTodoist() {
        Main.overview.hide();
        Main.panel.closeCalendar();
        const appSys = Shell.AppSystem.get_default();
        const app = TODOIST_APPS.map(id => appSys.lookup_app(id)).find(Boolean);
        if (app) {
            app.activate();
            return;
        }
        try {
            Gio.AppInfo.launch_default_for_uri(TODOIST_WEB, global.create_app_launch_context(0, -1));
        } catch (e) {
            console.warn(`Todoist Calendar: couldn’t open ${TODOIST_WEB}: ${e.message}`);
        }
    }

    openSettings() {
        Main.panel.closeCalendar();
        this.openPreferences();
    }
}
