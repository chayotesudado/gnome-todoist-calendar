// Pure logic for Todoist Calendar: no GI imports, so the tests run in plain gjs.
//
// Tasks come from the Todoist API. Each one is
// reduced to what the date menu needs: when it is due (a local day, and a
// time if it has one), its priority, and where it sits among its siblings.

export const API = 'https://api.todoist.com/api/v1';

const pad = n => String(n).padStart(2, '0');

// The local day of a Date, as YYYY-MM-DD.
export function dayKey(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// A Todoist due object to {day, time, recurring}. `time` is a Date for timed
// tasks and null for all-day ones. Todoist sends three forms of `due.date`:
// "2026-11-19" (all day), "2026-11-19T15:00:00" (floating, the user's local
// time) and "2026-11-19T21:00:00Z" (fixed time zone, given in UTC).
export function parseDue(due) {
    const s = due?.date;
    if (typeof s !== 'string')
        return null;
    const recurring = Boolean(due.is_recurring);

    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m)
        return {day: s, time: null, recurring};

    m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
    if (!m)
        return null;
    let time;
    if (m[7]) {
        time = new Date(Date.parse(s));
    } else {
        const [y, mo, d, h, mi, sec] = m.slice(1, 7).map(x => Number(x ?? 0));
        time = new Date(y, mo - 1, d, h, mi, sec);
    }
    if (Number.isNaN(time.getTime()))
        return null;
    return {day: dayKey(time), time, recurring};
}

// Todoist content is light Markdown. Show links as their text and drop
// emphasis markers, so the list reads like Todoist shows it.
export function plainText(content) {
    return String(content ?? '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/(\*\*|__)(.+?)\1/g, '$2')
        .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1$2')
        .replace(/`([^`]*)`/g, '$1')
        .trim();
}

export function escapeMarkup(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// API task → the fields we use. Tasks without a usable due date are dropped.
export function fromApi(t) {
    const due = parseDue(t?.due);
    if (!due || t.checked || t.is_deleted)
        return null;
    return {
        id: String(t.id),
        content: plainText(t.content),
        projectId: t.project_id ? String(t.project_id) : null,
        parentId: t.parent_id ? String(t.parent_id) : null,
        // Todoist: 4 is p1 (urgent) … 1 is p4 (none).
        priority: Number(t.priority) || 1,
        childOrder: Number(t.child_order) || 0,
        dayOrder: Number(t.day_order) || 0,
        ...due,
    };
}

// One page of a paginated v1 list: {results, next_cursor}.
export function parsePage(text) {
    const j = JSON.parse(text);
    return {
        results: Array.isArray(j?.results) ? j.results : [],
        next: typeof j?.next_cursor === 'string' && j.next_cursor ? j.next_cursor : null,
    };
}

function compare(a, b) {
    return (a.day < b.day ? -1 : a.day > b.day ? 1 : 0) ||
        // timed tasks first, in time order
        ((a.time ? 0 : 1) - (b.time ? 0 : 1)) ||
        ((a.time?.getTime() ?? 0) - (b.time?.getTime() ?? 0)) ||
        (b.priority - a.priority) ||
        (a.dayOrder - b.dayOrder) ||
        (a.childOrder - b.childOrder);
}

// Sorts a group and places subtasks under their parent when the parent is in
// the same group. Returns [{task, depth}].
export function nest(tasks) {
    const ids = new Set(tasks.map(t => t.id));
    const children = new Map();
    const roots = [];
    for (const t of [...tasks].sort(compare)) {
        if (t.parentId && ids.has(t.parentId) && t.parentId !== t.id) {
            if (!children.has(t.parentId))
                children.set(t.parentId, []);
            children.get(t.parentId).push(t);
        } else {
            roots.push(t);
        }
    }
    const out = [];
    const seen = new Set();
    const walk = (t, depth) => {
        if (seen.has(t.id))
            return;
        seen.add(t.id);
        out.push({task: t, depth});
        for (const c of (children.get(t.id) ?? []).sort((a, b) => a.childOrder - b.childOrder))
            walk(c, depth + 1);
    };
    for (const r of roots)
        walk(r, 0);
    // Anything left is in a parent cycle; show it rather than lose it.
    for (const t of tasks)
        walk(t, 0);
    return out;
}

// The groups shown for a selected day. On today, overdue tasks come first in
// their own group (as Todoist's Today view shows them).
export function groupsFor(tasks, day, today, {showOverdue = true} = {}) {
    const groups = [];
    if (day === today && showOverdue) {
        const overdue = tasks.filter(t => t.day < today);
        if (overdue.length)
            groups.push({kind: 'overdue', items: nest(overdue)});
    }
    const onDay = tasks.filter(t => t.day === day);
    if (onDay.length || !groups.length)
        groups.push({kind: 'day', items: nest(onDay)});
    return groups;
}

// Days that get a dot in the calendar.
export function dueDays(tasks) {
    return new Set(tasks.map(t => t.day));
}

// HTTP status → an error kind the UI words.
export function errorKind(status) {
    if (status === 401 || status === 403)
        return 'unauthorized';
    if (status === 429)
        return 'rate-limited';
    return 'unavailable';
}
