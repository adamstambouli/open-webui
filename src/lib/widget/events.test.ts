import { describe, expect, it } from 'vitest';

import {
	formatCompactCount,
	formatElapsed,
	getSSEEventReader,
	hydrateWidgetState,
	initialWidgetState,
	isWidgetActive,
	snapshotWidgetState,
	parseWidgetEvent,
	widgetDisplayStatus,
	widgetElapsedMs,
	widgetKey,
	widgetReducer,
	type WidgetEvent,
	type WidgetState
} from './events';

/**
 * Serves `text` as a Uint8Array stream cut into `size`-byte chunks, so SSE frames land
 * split across chunk boundaries the way a real network read does.
 */
const chunkedStream = (text: string, size: number): ReadableStream<Uint8Array> => {
	const bytes = new TextEncoder().encode(text);
	let offset = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset >= bytes.length) {
				controller.close();
				return;
			}
			controller.enqueue(bytes.slice(offset, offset + size));
			offset += size;
		}
	});
};

const readAll = async (body: ReadableStream<Uint8Array>) => {
	const reader = getSSEEventReader(body);
	const frames: { event?: string; data: string }[] = [];
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		if (value) frames.push({ event: value.event, data: value.data });
	}
	return frames;
};

const step = (id: string, label: string, status: 'running' | 'complete' | 'error') =>
	`event: widget_delta\ndata: ${JSON.stringify({ messageId: 'm1', type: 'step', id, label, status })}\n\n`;

// The reducer takes arrival time as an argument, so it stays pure and testable.
const reduceAll = (events: WidgetEvent[], from: WidgetState = initialWidgetState(0), at = 0) =>
	events.reduce((state, event) => widgetReducer(state, event, at), from);

const stepEvent = (
	id: string,
	label: string,
	status: 'running' | 'complete' | 'error'
): WidgetEvent => ({
	kind: 'step',
	messageId: 'm1',
	id,
	label,
	status
});

describe('widgetKey', () => {
	it('joins chat and message ids', () => {
		expect(widgetKey('c1', 'm1')).toBe('c1:m1');
	});
});

describe('getSSEEventReader', () => {
	it('parses frames split across chunk boundaries', async () => {
		const body =
			step('parse', 'Parsing request', 'running') +
			step('parse', 'Parsing request', 'complete') +
			`event: widget_done\ndata: ${JSON.stringify({ messageId: 'm1' })}\n\n`;

		// One byte at a time: every frame is split, including mid-JSON and mid-field-name.
		const frames = await readAll(chunkedStream(body, 1));

		expect(frames.map((f) => f.event)).toEqual(['widget_delta', 'widget_delta', 'widget_done']);
		expect(parseWidgetEvent(frames[0].event, frames[0].data)).toEqual({
			kind: 'step',
			messageId: 'm1',
			id: 'parse',
			label: 'Parsing request',
			status: 'running'
		});
		expect(parseWidgetEvent(frames[2].event, frames[2].data)).toEqual({
			kind: 'done',
			messageId: 'm1'
		});
	});
});

describe('parseWidgetEvent', () => {
	it('parses step, metric, done and error frames', () => {
		expect(
			parseWidgetEvent(
				'widget_delta',
				'{"messageId":"m1","type":"metric","key":"sources","label":"Sources","value":3}'
			)
		).toEqual({ kind: 'metric', messageId: 'm1', key: 'sources', label: 'Sources', value: 3 });

		expect(
			parseWidgetEvent('widget_error', '{"messageId":"m1","message":"Retrieval unavailable"}')
		).toEqual({ kind: 'error', messageId: 'm1', message: 'Retrieval unavailable' });
	});

	it('returns null for malformed and unknown frames instead of throwing', () => {
		const bad: [string | undefined, string][] = [
			['widget_delta', '{"messageId":"m1","type":"step","id":"rank"'], // truncated JSON
			['widget_delta', 'not json at all'],
			['widget_delta', '{"type":"step","id":"rank","label":"Rank","status":"running"}'], // no messageId
			['widget_delta', '{"messageId":"m1","type":"telemetry","value":1}'], // unknown type
			['widget_delta', '{"messageId":"m1","type":"step","id":"rank","label":"Rank"}'], // no status
			['widget_delta', '{"messageId":"m1","type":"step","id":"rank","label":"R","status":"weird"}'],
			['widget_delta', '{"messageId":"m1","type":"metric","key":"s","label":"S","value":"3"}'],
			['chat:completion', '{"messageId":"m1"}'], // unrelated event name
			[undefined, '{"messageId":"m1"}'] // unnamed frame
		];

		for (const [name, data] of bad) {
			expect(parseWidgetEvent(name, data), `${name} / ${data}`).toBeNull();
		}
	});
});

describe('step timing', () => {
	it('stamps startedAt entering running and endedAt leaving it', () => {
		const running = widgetReducer(
			initialWidgetState(0),
			stepEvent('parse', 'Parsing query', 'running'),
			1_000
		);
		expect(running.steps[0].startedAt).toBe(1_000);
		expect(running.steps[0].endedAt).toBeUndefined();

		const finished = widgetReducer(running, stepEvent('parse', 'Parsing query', 'complete'), 1_700);
		expect(finished.steps[0]).toEqual({
			id: 'parse',
			label: 'Parsing query',
			status: 'complete',
			startedAt: 1_000,
			endedAt: 1_700
		});
	});

	it('does not re-stamp when the same frame arrives twice', () => {
		// The mock emits a deliberate duplicate; re-stamping would inflate the duration.
		const first = widgetReducer(
			initialWidgetState(0),
			stepEvent('search', 'Searching', 'running'),
			1_000
		);
		const second = widgetReducer(first, stepEvent('search', 'Searching', 'running'), 5_000);

		expect(second.steps[0].startedAt).toBe(1_000);
		expect(second.steps).toEqual(first.steps);
	});

	it('leaves a step that was never running without timings', () => {
		const state = widgetReducer(initialWidgetState(0), stepEvent('x', 'X', 'complete'), 1_000);
		expect(state.steps[0].startedAt).toBeUndefined();
		expect(state.steps[0].endedAt).toBeUndefined();
	});
});

describe('error orphaning', () => {
	it('marks steps still running when the session errored', () => {
		// Nothing is in progress under a dead session; leaving a spinner spinning there
		// claims work that stopped.
		const streaming = reduceAll(
			[
				stepEvent('parse', 'Parsing query', 'complete'),
				stepEvent('search', 'Searching', 'running')
			],
			initialWidgetState(0),
			1_000
		);

		const errored = widgetReducer(
			streaming,
			{ kind: 'error', messageId: 'm1', message: 'Backend down' },
			2_500
		);

		expect(errored.status).toBe('error');
		expect(errored.steps.map((s) => s.status)).toEqual(['complete', 'error']);
		const orphan = errored.steps[1];
		expect(orphan.startedAt).toBe(1_000); // keeps when it began
		expect(orphan.endedAt).toBe(2_500); // and records when it stopped
	});
});

describe('sources', () => {
	const source = (n: number, title: string, url: string): WidgetEvent => ({
		kind: 'source',
		messageId: 'm1',
		n,
		title,
		url
	});

	it('parses source frames and rejects malformed ones', () => {
		expect(
			parseWidgetEvent(
				'widget_delta',
				'{"messageId":"m1","type":"source","n":1,"title":"Week 4 notes","url":"https://x.test/a"}'
			)
		).toEqual({
			kind: 'source',
			messageId: 'm1',
			n: 1,
			title: 'Week 4 notes',
			url: 'https://x.test/a'
		});

		const bad = [
			'{"messageId":"m1","type":"source","n":"1","title":"T","url":"u"}',
			'{"messageId":"m1","type":"source","n":1,"url":"u"}',
			'{"messageId":"m1","type":"source","n":1,"title":"T"}'
		];
		for (const data of bad) expect(parseWidgetEvent('widget_delta', data), data).toBeNull();
	});

	it('upserts by n, in first-seen order, idempotently', () => {
		const state = reduceAll([
			source(1, 'First', 'https://x.test/1'),
			source(2, 'Second', 'https://x.test/2'),
			source(1, 'First', 'https://x.test/1'), // duplicate
			source(2, 'Second, revised', 'https://x.test/2')
		]);

		expect(state.sources).toEqual([
			{ n: 1, title: 'First', url: 'https://x.test/1' },
			{ n: 2, title: 'Second, revised', url: 'https://x.test/2' }
		]);
	});
});

describe('snapshotWidgetState / hydrateWidgetState', () => {
	const finished: WidgetState = {
		status: 'complete',
		steps: [
			{
				id: 'parse',
				label: 'Parsing request',
				status: 'complete',
				startedAt: 1_100,
				endedAt: 1_800
			},
			{ id: 'rank', label: 'Ranking passages', status: 'complete' }
		],
		sources: [{ n: 1, title: 'Week 4 notes', url: 'https://x.test/a' }],
		metrics: { sources: { label: 'Sources', value: 7 } },
		startedAt: 1_000,
		finishedAt: 7_800,
		endedAt: 34_400
	};

	it('round-trips a finished session through JSON', () => {
		const snapshot = snapshotWidgetState(finished);
		expect(snapshot?.v).toBe(1);

		// Stored on the message, so it makes the trip through serialization.
		expect(hydrateWidgetState(JSON.parse(JSON.stringify(snapshot)))).toEqual(finished);
	});

	it('round-trips an errored session including its message', () => {
		const errored: WidgetState = { ...finished, status: 'error', errorMessage: 'Backend down' };
		expect(hydrateWidgetState(snapshotWidgetState(errored))).toEqual(errored);
	});

	it('refuses to snapshot a session that is still running', () => {
		expect(snapshotWidgetState({ ...finished, status: 'streaming' })).toBeNull();
		expect(snapshotWidgetState({ ...finished, status: 'starting' })).toBeNull();
	});

	it('refuses to snapshot a terminal session that never recorded its end', () => {
		// WidgetSnapshot's type promises endedAt; without this guard it could lie.
		expect(snapshotWidgetState({ ...finished, endedAt: undefined })).toBeNull();
	});

	it('rejects anything it cannot fully vouch for', () => {
		const snapshot = snapshotWidgetState(finished);
		const cases: [string, unknown][] = [
			['not an object', 'nope'],
			['null', null],
			['no version', { ...snapshot, v: undefined }],
			['future version', { ...snapshot, v: 2 }],
			['non-terminal status', { ...snapshot, status: 'streaming' }],
			['unknown status', { ...snapshot, status: 'paused' }],
			['missing endedAt', { ...snapshot, endedAt: undefined }],
			['non-finite timestamp', { ...snapshot, endedAt: Number.NaN }],
			['ended before it started', { ...snapshot, startedAt: 40_000 }],
			['stream outlasting the session', { ...snapshot, finishedAt: 40_000 }],
			['steps not an array', { ...snapshot, steps: {} }],
			[
				'step timing that is not a number',
				{ ...snapshot, steps: [{ id: 'a', label: 'A', status: 'complete', startedAt: 'soon' }] }
			],
			['sources not an array', { ...snapshot, sources: {} }],
			['source missing a url', { ...snapshot, sources: [{ n: 1, title: 'T' }] }],
			['source with a text number', { ...snapshot, sources: [{ n: '1', title: 'T', url: 'u' }] }],
			['step missing a label', { ...snapshot, steps: [{ id: 'a', status: 'complete' }] }],
			['step with a bogus status', { ...snapshot, steps: [{ id: 'a', label: 'A', status: 'x' }] }],
			['metrics as an array', { ...snapshot, metrics: [] }],
			['metric with a text value', { ...snapshot, metrics: { s: { label: 'S', value: '7' } } }]
		];

		for (const [name, value] of cases) {
			expect(hydrateWidgetState(value), name).toBeNull();
		}
	});
});

describe('formatCompactCount', () => {
	it('leaves counts under a thousand alone', () => {
		expect(formatCompactCount(0)).toBe('0');
		expect(formatCompactCount(512)).toBe('512');
		expect(formatCompactCount(999)).toBe('999');
	});

	it('uses a lowercase k with one decimal, dropping a trailing zero', () => {
		expect(formatCompactCount(1000)).toBe('1k');
		expect(formatCompactCount(5123)).toBe('5.1k');
		expect(formatCompactCount(5000)).toBe('5k');
		expect(formatCompactCount(999_949)).toBe('999.9k');
	});

	it('promotes across the suffix boundary rather than printing 1000k', () => {
		expect(formatCompactCount(999_950)).toBe('1M');
		expect(formatCompactCount(1_000_000)).toBe('1M');
		expect(formatCompactCount(2_450_000)).toBe('2.5M');
	});

	it('never renders NaN or a negative count', () => {
		expect(formatCompactCount(Number.NaN)).toBe('0');
		expect(formatCompactCount(Number.POSITIVE_INFINITY)).toBe('0');
		expect(formatCompactCount(-5)).toBe('0');
	});
});

describe('formatElapsed', () => {
	it('renders seconds under a minute', () => {
		expect(formatElapsed(0)).toBe('0s');
		expect(formatElapsed(12_400)).toBe('12s');
		expect(formatElapsed(59_999)).toBe('59s');
	});

	it('renders minutes and seconds up to an hour', () => {
		expect(formatElapsed(60_000)).toBe('1m 0s');
		expect(formatElapsed(141_000)).toBe('2m 21s');
		expect(formatElapsed(3_599_000)).toBe('59m 59s');
	});

	it('drops to hours and minutes past an hour', () => {
		expect(formatElapsed(3_600_000)).toBe('1h 0m');
		expect(formatElapsed(3_840_000)).toBe('1h 4m');
	});

	it('never renders NaN or a negative duration', () => {
		expect(formatElapsed(Number.NaN)).toBe('0s');
		expect(formatElapsed(-1000)).toBe('0s');
	});
});

// These two derive what the user actually sees. Both regressed while they lived inline
// in the component, where nothing could test them, so they live here now.
describe('widgetDisplayStatus', () => {
	it('does not report complete just because the scripted stream ended', () => {
		// The stream finishes in ~7s; the answer often needs far longer. Claiming
		// "complete" here showed Complete ~30s before the answer stopped arriving.
		expect(widgetDisplayStatus('complete', false, false)).toBe('streaming');
		expect(isWidgetActive(widgetDisplayStatus('complete', false, false))).toBe(true);
	});

	it('reports complete only once the generation is done', () => {
		expect(widgetDisplayStatus('complete', true, false)).toBe('complete');
		expect(widgetDisplayStatus('streaming', true, false)).toBe('complete');
		expect(isWidgetActive('complete')).toBe(false);
	});

	it('lets either the stream or the message raise an error', () => {
		expect(widgetDisplayStatus('error', false, false)).toBe('error');
		expect(widgetDisplayStatus('streaming', false, true)).toBe('error');
		expect(widgetDisplayStatus('complete', true, true)).toBe('error');
	});

	it('passes through the pre-terminal statuses untouched', () => {
		expect(widgetDisplayStatus('starting', false, false)).toBe('starting');
		expect(widgetDisplayStatus('streaming', false, false)).toBe('streaming');
	});
});

describe('widgetElapsedMs', () => {
	const ended: WidgetState = {
		status: 'complete',
		steps: [],
		sources: [],
		metrics: {},
		startedAt: 1_000,
		finishedAt: 7_800, // the scripted stream stopped here
		endedAt: 34_400 // the generation stopped here
	};

	it('measures the generation, never the scripted stream', () => {
		expect(widgetElapsedMs(ended, false, 99_000)).toBe(33_400);
	});

	it('falls back to now — not to the stream — while the end is still propagating', () => {
		// The instant generation stops, the store write has not reached this state yet.
		// Reaching for finishedAt here is what displayed a 33s session as 6s.
		const unstamped: WidgetState = { ...ended, endedAt: undefined };
		expect(widgetElapsedMs(unstamped, false, 34_400)).toBe(33_400);
	});

	it('tracks now while the session is still running', () => {
		expect(widgetElapsedMs({ ...ended, endedAt: undefined }, true, 21_000)).toBe(20_000);
		// An already-stamped end is ignored while active — continue-response restarts.
		expect(widgetElapsedMs(ended, true, 40_000)).toBe(39_000);
	});

	it('is zero without state and never negative', () => {
		expect(widgetElapsedMs(undefined, true, 5_000)).toBe(0);
		expect(widgetElapsedMs(ended, true, 0)).toBe(0);
	});
});

describe('widgetReducer', () => {
	it('moves starting -> streaming on the first delta', () => {
		const state = initialWidgetState(1000);
		expect(state.status).toBe('starting');

		const next = widgetReducer(
			state,
			{ kind: 'step', messageId: 'm1', id: 'parse', label: 'Parsing', status: 'running' },
			0
		);
		expect(next.status).toBe('streaming');
		expect(next.startedAt).toBe(1000);
	});

	it('upserts steps in first-seen order and metrics by key', () => {
		const state = reduceAll([
			{ kind: 'step', messageId: 'm1', id: 'parse', label: 'Parsing', status: 'running' },
			{ kind: 'step', messageId: 'm1', id: 'search', label: 'Searching', status: 'running' },
			{ kind: 'metric', messageId: 'm1', key: 'sources', label: 'Sources', value: 2 },
			{ kind: 'step', messageId: 'm1', id: 'parse', label: 'Parsing', status: 'complete' },
			{ kind: 'metric', messageId: 'm1', key: 'sources', label: 'Sources', value: 5 }
		]);

		expect(state.steps).toEqual([
			{ id: 'parse', label: 'Parsing', status: 'complete', startedAt: 0, endedAt: 0 },
			{ id: 'search', label: 'Searching', status: 'running', startedAt: 0 }
		]);
		expect(state.metrics).toEqual({ sources: { label: 'Sources', value: 5 } });
	});

	it('is idempotent for a duplicated step frame', () => {
		const frame: WidgetEvent = {
			kind: 'step',
			messageId: 'm1',
			id: 'search',
			label: 'Searching',
			status: 'running'
		};
		const once = reduceAll([
			{ kind: 'step', messageId: 'm1', id: 'parse', label: 'Parsing', status: 'complete' },
			frame
		]);
		const twice = widgetReducer(once, frame, 0);

		expect(twice).toEqual(once);
		expect(twice.steps).toHaveLength(2);
	});

	it('finishes on done and on error, and ignores anything after a terminal status', () => {
		const streaming = reduceAll([
			{ kind: 'step', messageId: 'm1', id: 'parse', label: 'Parsing', status: 'complete' }
		]);

		const completed = widgetReducer(streaming, { kind: 'done', messageId: 'm1' }, 0);
		expect(completed.status).toBe('complete');

		const errored = widgetReducer(
			streaming,
			{ kind: 'error', messageId: 'm1', message: 'Retrieval unavailable' },
			0
		);
		expect(errored.status).toBe('error');
		expect(errored.errorMessage).toBe('Retrieval unavailable');

		// A late delta must not reopen a finished widget.
		const late = widgetReducer(
			completed,
			{ kind: 'step', messageId: 'm1', id: 'zombie', label: 'Zombie', status: 'running' },
			0
		);
		expect(late).toBe(completed);
		expect(widgetReducer(errored, { kind: 'done', messageId: 'm1' }, 0)).toBe(errored);
	});
});
