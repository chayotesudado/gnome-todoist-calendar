// Run with: gjs -m tests/tasks.test.js   (exits non-zero on failure)
import System from 'system';
import * as T from '../lib/tasks.js';

let failed = 0;
function test(name, fn) {
    try {
        fn();
        print(`ok - ${name}`);
    } catch (e) {
        failed++;
        print(`FAIL - ${name}\n  ${e.message}`);
    }
}
function eq(a, b, msg = '') {
    const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
    if (x !== y)
        throw new Error(`${msg} expected ${y}, got ${x}`);
}

test('due: all-day date', () => {
    eq(T.parseDue({date: '2026-11-19', is_recurring: false}), {day: '2026-11-19', time: null, recurring: false});
});

test('due: floating time is local', () => {
    const d = T.parseDue({date: '2026-11-19T15:30:00.000000', is_recurring: true});
    eq(d.day, '2026-11-19');
    eq([d.time.getHours(), d.time.getMinutes()], [15, 30]);
    eq(d.recurring, true);
});

test('due: UTC time lands on the local day', () => {
    const d = T.parseDue({date: '2026-11-20T03:00:00Z'});
    const local = new Date(Date.UTC(2026, 10, 20, 3));
    eq(d.day, T.dayKey(local));
    eq(d.time.getTime(), local.getTime());
});

test('due: missing or junk', () => {
    eq(T.parseDue(null), null);
    eq(T.parseDue({date: 'tomorrow'}), null);
});

test('content: markdown to plain text', () => {
    eq(T.plainText('Call [Ana](https://x.y) about **rent** and *keys* `now`'), 'Call Ana about rent and keys now');
    eq(T.plainText('5 * 3 = 15'), '5 * 3 = 15');
});

test('markup escaping', () => {
    eq(T.escapeMarkup('a < b & "c"'), 'a &lt; b &amp; &quot;c&quot;');
});

test('fromApi: keeps what the UI needs, drops undated and done', () => {
    const t = T.fromApi({id: 7, content: 'x', project_id: 'p', parent_id: null, priority: 4,
        child_order: 2, day_order: 1, checked: false, due: {date: '2026-11-19'}});
    eq([t.id, t.projectId, t.parentId, t.priority, t.day], ['7', 'p', null, 4, '2026-11-19']);
    eq(T.fromApi({id: 1, content: 'x', due: null}), null);
    eq(T.fromApi({id: 1, content: 'x', checked: true, due: {date: '2026-11-19'}}), null);
});

test('pages', () => {
    eq(T.parsePage('{"results":[1,2],"next_cursor":"abc"}'), {results: [1, 2], next: 'abc'});
    eq(T.parsePage('{"results":[],"next_cursor":null}'), {results: [], next: null});
});

const task = (id, o = {}) => ({id, content: id, projectId: null, parentId: null, priority: 1,
    childOrder: 0, dayOrder: 0, day: '2026-11-19', time: null, recurring: false, ...o});

test('order: timed first by time, then priority, then manual order', () => {
    const out = T.nest([
        task('low'), task('p1', {priority: 4}), task('late', {time: new Date(2026, 10, 19, 17)}),
        task('early', {time: new Date(2026, 10, 19, 9)}), task('first', {dayOrder: -1}),
    ]).map(x => x.task.id);
    eq(out, ['early', 'late', 'p1', 'first', 'low']);
});

test('subtasks go under their parent', () => {
    const out = T.nest([
        task('b', {priority: 4}), task('a'), task('a2', {parentId: 'a', childOrder: 2}),
        task('a1', {parentId: 'a', childOrder: 1, priority: 4}), task('orphan', {parentId: 'gone'}),
    ]).map(x => `${x.task.id}:${x.depth}`);
    eq(out, ['b:0', 'a:0', 'a1:1', 'a2:1', 'orphan:0']);
});

test('parent cycles do not lose tasks', () => {
    const out = T.nest([task('x', {parentId: 'y'}), task('y', {parentId: 'x'})]);
    eq(out.length, 2);
});

test('groups: today shows overdue first, other days only their own', () => {
    const tasks = [task('old', {day: '2026-11-17'}), task('now'), task('next', {day: '2026-11-20'})];
    const today = T.groupsFor(tasks, '2026-11-19', '2026-11-19');
    eq(today.map(g => [g.kind, g.items.map(i => i.task.id)]), [['overdue', ['old']], ['day', ['now']]]);
    eq(T.groupsFor(tasks, '2026-11-19', '2026-11-19', {showOverdue: false}).length, 1);
    eq(T.groupsFor(tasks, '2026-11-20', '2026-11-19').map(g => g.kind), ['day']);
    eq(T.groupsFor([], '2026-11-19', '2026-11-19'), [{kind: 'day', items: []}]);
});

test('dots and errors', () => {
    eq([...T.dueDays([task('a'), task('b'), task('c', {day: '2026-11-21'})])], ['2026-11-19', '2026-11-21']);
    eq([T.errorKind(401), T.errorKind(403), T.errorKind(429), T.errorKind(500)],
        ['unauthorized', 'unauthorized', 'rate-limited', 'unavailable']);
});

if (failed) {
    print(`${failed} failed`);
    System.exit(1);
}
